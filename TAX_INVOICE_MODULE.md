# Tax Invoice Module (manual GST invoicing)

A standalone, admin-only module for raising GST invoices by hand — type a party,
line items, quantities and GST, preview, then download as PDF or Excel. Tracks
payments and shows what each party still owes.

## How it differs from the existing Accounting invoices

| | Accounting (existing) | Tax Invoice (this module) |
|---|---|---|
| Source of data | Auto-counted from MAWB/HAWB | Typed in by hand |
| Database | `ediss_invoices` (separate DB) | `ediss_db` (main app DB) |
| Tables | `invoices` | `tax_invoices`, `tax_invoice_items`, `tax_invoice_payments`, `tax_invoice_parties` |
| Numbering | `invoice_no_seq` | `tax_invoice_no_seq` |
| Routes | `/api/reports/air-invoice/*` | `/api/tax-invoices/*` |

Nothing in this module reads or writes MAWB, HAWB, profile or Accounting data.
The only shared code is `utils/invoiceConstants.ts` (the fixed supplier, bank
and SAC details), which is imported read-only.

## Setup

```bash
# 1. Install (adds pdfkit + exceljs)
npm install

# 2. Create the tables — idempotent, safe to re-run
npm run migrate:tax-invoice

# 3. Unit checks: GST maths, rounding, validation, PDF/Excel rendering
npm run test:tax-invoice
```

An end-to-end API exercise is also available. It creates a clearly-marked test
party and invoice, drives every endpoint, and deletes everything it made:

```bash
# with the backend running on :5099
BASE_URL=http://localhost:5099 npx ts-node --transpile-only src/taxInvoiceE2E.ts
```

## Access control

Every route is behind `authenticate` + `requireRole(['master_admin','admin'])`,
applied once at the router level. Role `user` gets 403. Hard-deleting an invoice
additionally requires `master_admin` and is refused once any payment exists —
cancel it instead.

## GST handling

The supplier's GSTIN starts `06` (Haryana). A party whose state code is also
`06` is billed **CGST + SGST** (half each); anyone else gets **IGST**. A party
with no state code is treated as inter-state, which never under-charges tax.

- Per-line GST rates are supported; the invoice groups them into a slab summary.
- An invoice-level discount is apportioned across slabs in proportion to each
  slab's share of the subtotal, so tax is charged on the post-discount value.
  The last slab absorbs the rounding remainder, so the parts always sum exactly.
- The grand total is rounded to the nearest rupee, with the difference shown
  as `round_off`.

**The server always recomputes every figure** from the raw line items before
saving (`utils/taxInvoiceCalc.ts`). Totals sent by the browser are ignored.
The client mirror in `esic/src/pages/TaxInvoice/taxInvoiceCalc.ts` exists only
to make the on-screen preview instant — keep the two algorithms in step.

## Money and dates

- Paid / pending are always derived from `SUM(tax_invoice_payments.amount)`.
  Nothing is cached on the invoice row, so the figures cannot drift.
- Cancelled invoices keep their number for audit but count as zero pending.
- Payments are capped at the outstanding balance, checked under `SELECT … FOR
  UPDATE` so two simultaneous receipts can't jointly overshoot.
- Dates are selected as text (`TO_CHAR(… ,'YYYY-MM-DD')`). A Postgres `DATE`
  otherwise serialises to JSON as a UTC timestamp and shifts the calendar day
  by one. Date formatters parse the string textually for the same reason.

## Invoice numbers

Format `EMS/<financial-year>/<00001>`, e.g. `EMS/2026-27/00042`. Auto-suggested
from `tax_invoice_no_seq` and editable before saving. The suggestion endpoint
peeks without consuming, so previewing never burns numbers. A duplicate number
returns 409 rather than overwriting anything.

## Endpoints

All under `/api/tax-invoices`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/parties` | List parties (`?search=`) |
| POST/PUT | `/parties`, `/parties/:id` | Create / update a party |
| DELETE | `/parties/:id` | Deactivate (soft) |
| GET | `/next-number` | Suggested invoice number |
| POST | `/preview` | Totals without saving |
| GET | `/` | List (`search, party_id, created_by, status, from_date, to_date, page, pageSize`) |
| GET/POST/PUT | `/`, `/:id` | Read / create / update |
| POST | `/:id/cancel` | Cancel |
| DELETE | `/:id` | Hard delete (master_admin, no payments) |
| GET | `/:id/pdf`, `/:id/excel` | Download |
| POST | `/:id/payments` | Record a receipt |
| DELETE | `/:id/payments/:paymentId` | Undo a receipt |
| GET | `/dashboard/summary` | Invoiced / received / pending totals |
| GET | `/dashboard/by-party` | Outstanding grouped by party |
| GET | `/dashboard/creators` | Users for the user-wise filter |

## Frontend

`esic/src/pages/TaxInvoice/` — reached from the **Tax Invoice** navbar menu
(admin only). Tabs: Invoices, New Invoice, Parties, Payment Dashboard.

Downloads are fetched as blobs with the bearer token attached; a plain `<a
href>` would 401.
