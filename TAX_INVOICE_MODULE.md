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

# 2. Create / extend the tables — applies schema_v8 then schema_v9 (party
#    billing rates). Idempotent, safe to re-run.
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

The E2E run creates real invoices, so it uses up two invoice numbers each
time it runs. Run it against a test database, not production.

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

## Party billing rate

A party can carry one rate and the basis it is charged on: **As per HAWB**,
**As per MAWB** or **As per HBL** (`rate_basis` = `hawb` / `mawb` / `hbl`,
plus `rate`). Both are optional, but must be set together.

Picking the party on the New Invoice form fills a line with the party's rate,
unit (`HAWB` / `MAWB` / `HBL`), a default description and SAC 998439. The
quantity is left empty on purpose: it is the number of HAWB/MAWB/HBL being
billed and is entered on every invoice. The rate on the line can be changed
for that one invoice without touching the party; change the party itself to
change the default. Opening an existing invoice for edit never re-applies the
rate. Use **Apply party rate** to pull it in again by hand.

## Invoice numbers

Format `EMS/<financial-year>/<00001>`, e.g. `EMS/2026-27/00042`. Auto-suggested
from `tax_invoice_no_seq` and editable before saving. The suggestion endpoint
peeks without consuming, so previewing never burns numbers. A duplicate number
returns 409 rather than overwriting anything.

**Running counter.** Saving an invoice whose number has the current year's
`EMS/<FY>/<n>` shape moves the counter past `n`, so the next suggestion is
always +1. It never moves backwards, and other number shapes leave it alone.
The suggestion also skips any number already printed this financial year.

**Starting number.** When invoices were already issued elsewhere, set where
numbering continues from with **Change starting number** under the Invoice No.
field on New Invoice (`PUT /numbering`). It must be above the highest number
already issued this financial year, so it can't create duplicates.

## Download file names

`<INVOICE NO>_<PARTY FIRST NAME>_<MON>_BILL_<YYYY>`, all capitals, e.g.
`EMS-2026-27-00042_NAVI_SEP_BILL_2026.pdf`. Month and year come from the
invoice date. `/` in the invoice number becomes `-`, and a leading `M/s.` on
the party name is skipped. The server (`Content-Disposition`) and the browser
(`taxInvoiceCalc.ts`) build the same name; keep the two helpers in step.

## PDF and Excel layout

Both downloads follow the Tally invoice layout the parties already receive. The
whole invoice sits in one ruled frame. Boxed cells hold the supplier, the buyer
and the reference fields (Invoice No., Dated, Delivery Note, …). The item table
has the columns Sl No. / Description of Goods / Quantity / Rate / per / Amount,
with the SAC code printed under each description. Under the items come
`LESS : DISCOUNT`, one `OUTPUT IGST n%` line per GST slab (or `OUTPUT CGST` and
`OUTPUT SGST` at half rate each) and `ROUND OFF`. The column rules continue
down through an empty gap to the Total row. Below that are the amount in words,
a GST slab summary when the rates differ, the remarks (notes and bank details),
the declaration and the signature box.

`ledgerLines` and `totalQuantity` in `utils/taxInvoicePdf.ts` decide those
lines for both renderers, so the PDF and the Excel always agree. A long PDF
continues on further pages, and the Total row and footer stay together. The
Excel sheet hides gridlines, so only the boxes show.

## Endpoints

All under `/api/tax-invoices`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/parties` | List parties (`?search=`) |
| POST/PUT | `/parties`, `/parties/:id` | Create / update a party |
| DELETE | `/parties/:id` | Deactivate (soft) |
| GET | `/next-number` | Suggested invoice number |
| GET | `/numbering` | Counter state: next number, highest issued this FY |
| PUT | `/numbering` | Set the next invoice number (`{ next_number }`) |
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
