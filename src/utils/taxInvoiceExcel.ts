/**
 * Excel (.xlsx) renderer for the standalone Tax Invoice module.
 *
 * Produces a genuine xlsx workbook (not CSV with a renamed extension), so the
 * numbers arrive as numbers and stay usable in Excel formulas.
 *
 * The sheet mirrors the PDF's Tally-style layout with real cell borders:
 * boxed header cells, an item table whose column rules run past the tax and
 * round-off rows down to the Total row, and the words / remarks / declaration
 * / signature boxes below. Gridlines are hidden so only the boxes show.
 */

import ExcelJS from 'exceljs';
import { INVOICE_SUPPLIER, numberToWordsINR } from './invoiceConstants';
import { ledgerLines, totalQuantity, bankLines, DECLARATION } from './taxInvoicePdf';
import type { PdfInvoice } from './taxInvoicePdf';

const FONT = 'Arial';
const MONEY_FMT = '#,##0.00';
const SIGNED_FMT = '#,##0.00;"(-)"#,##0.00';   // Tally prints negatives as (-)0.40
const THIN: Partial<ExcelJS.Border> = { style: 'thin', color: { argb: 'FF000000' } };
const MEDIUM: Partial<ExcelJS.Border> = { style: 'medium', color: { argb: 'FF000000' } };

// A Sl | B Description | C Quantity | D Rate | E per | F Amount
const C_SL = 1, C_DESC = 2, C_QTY = 3, C_RATE = 4, C_PER = 5, C_AMT = 6;
const LAST_COL = C_AMT;
const DESC_CHARS_PER_LINE = 52;     // rough wrap estimate for column B at 9pt
const MIN_BODY_ROWS = 18;           // item area height above Total: the Tally-style gap

/** "2026-09-29" -> "29-09-2026", parsed textually so no timezone can shift it. */
const dateStr = (value: any): string => {
  const s = String(value ?? '');
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;

  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
};

/** Number format that prints the unit after the count, e.g. 43 -> "43 HBL", still numeric. */
const qtyFmt = (n: number, unit: string): string => {
  const base = Number.isInteger(Number(n)) ? '#,##0' : '#,##0.###';
  const u = String(unit || '').replace(/"/g, '').trim();
  return u ? `${base}" ${u}"` : base;
};

type CellOpts = {
  bold?: boolean;
  italic?: boolean;
  size?: number;
  color?: string;
  h?: 'left' | 'center' | 'right';
  v?: 'top' | 'middle' | 'bottom';
  wrap?: boolean;
  numFmt?: string;
};

type Side = 'top' | 'left' | 'bottom' | 'right';
type RefCell = { label: string; value?: string };
type TextLine = { text: string; bold?: boolean; size?: number };

export async function renderInvoiceExcel(inv: PdfInvoice): Promise<Buffer> {
  const party = inv.party_snapshot || {};
  const isIntra = inv.gst_mode === 'cgst_sgst';

  const wb = new ExcelJS.Workbook();
  wb.creator = INVOICE_SUPPLIER.name;
  wb.created = new Date();

  const ws = wb.addWorksheet('Tax Invoice', {
    views: [{ showGridLines: false }],
    pageSetup: {
      paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      horizontalCentered: true,
      margins: { left: 0.4, right: 0.4, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 },
    },
  });

  ws.columns = [
    { width: 6 },   // A  Sl No.
    { width: 46 },  // B  Description of Goods
    { width: 13 },  // C  Quantity
    { width: 12 },  // D  Rate
    { width: 8 },   // E  per
    { width: 16 },  // F  Amount
  ];

  // ─── Cell helpers ──────────────────────────────────────────────────────────

  /** Writes a value (merging first when a range is given) and styles it. */
  const write = (row: number, col: number, value: ExcelJS.CellValue, o: CellOpts = {},
    toCol = col, toRow = row): ExcelJS.Cell => {
    if (toCol !== col || toRow !== row) ws.mergeCells(row, col, toRow, toCol);
    const c = ws.getCell(row, col);
    c.value = value;
    c.font = { name: FONT, size: o.size ?? 9, bold: !!o.bold, italic: !!o.italic,
      ...(o.color ? { color: { argb: o.color } } : {}) };
    c.alignment = { horizontal: o.h ?? 'left', vertical: o.v ?? 'middle', wrapText: !!o.wrap };
    if (o.numFmt) c.numFmt = o.numFmt;
    return c;
  };

  /**
   * Adds one border edge to one cell. A fresh style object is assigned every
   * time: cells inside a merge share their master's style object, so mutating
   * `cell.border` in place would paint the edge onto the whole merged range.
   */
  const edge = (row: number, col: number, side: Side, line: Partial<ExcelJS.Border> = THIN) => {
    const c = ws.getCell(row, col);
    c.style = { ...c.style, border: { ...(c.style.border || {}), [side]: line } };
  };

  const outline = (r1: number, c1: number, r2: number, c2: number, line = THIN) => {
    for (let c = c1; c <= c2; c++) { edge(r1, c, 'top', line); edge(r2, c, 'bottom', line); }
    for (let r = r1; r <= r2; r++) { edge(r, c1, 'left', line); edge(r, c2, 'right', line); }
  };

  /** Item-table body row: only the vertical column rules, no horizontal lines. */
  const columnRules = (row: number) => {
    for (let c = C_SL; c <= LAST_COL; c++) { edge(row, c, 'left'); edge(row, c, 'right'); }
  };

  const height = (row: number, h: number) => { ws.getRow(row).height = h; };

  let r = 1;

  // ─── Title ─────────────────────────────────────────────────────────────────
  write(r, 1, 'TAX INVOICE', { bold: true, size: 13, h: 'center' }, LAST_COL);
  height(r, 20);
  r++;
  if (inv.is_cancelled) {
    write(r, 1, '** CANCELLED **', { bold: true, size: 11, color: 'FFB91C1C', h: 'center' }, LAST_COL);
    r++;
  }
  const frameTop = r;

  /**
   * Boxed text on the left (A:B, one line per row) and a grid of reference
   * cells on the right (C:D | E:F, a label row then a value row). A one-cell
   * grid row spans C:F. The grid's last row takes up any rows left over.
   */
  const headerBlock = (lines: TextLine[], refRows: RefCell[][]) => {
    const top = r;
    const bottom = top + Math.max(lines.length, refRows.length * 2) - 1;

    for (let i = top; i <= bottom; i++) height(i, 13);
    lines.forEach((l, i) => {
      write(top + i, C_SL, l.text, { bold: l.bold, size: l.size }, C_DESC);
      if ((l.size || 9) > 10) height(top + i, 16);
    });
    outline(top, C_SL, bottom, C_DESC);

    let gr = top;
    refRows.forEach((row, i) => {
      const end = i === refRows.length - 1 ? bottom : gr + 1;
      const spans: Array<[number, number]> = row.length === 1 ? [[C_QTY, LAST_COL]] : [[C_QTY, C_RATE], [C_PER, LAST_COL]];
      row.forEach((cell, j) => {
        const [c1, c2] = spans[j];
        write(gr, c1, cell.label, { size: 8, v: 'top' }, c2);
        write(gr + 1, c1, cell.value ?? null, { bold: true, v: 'top' }, c2, end);
        outline(gr, c1, end, c2);
      });
      gr = end + 1;
    });

    r = bottom + 1;
  };

  // ─── Supplier + references ─────────────────────────────────────────────────
  headerBlock([
    { text: INVOICE_SUPPLIER.name, bold: true, size: 11 },
    ...INVOICE_SUPPLIER.addressLines.map((l) => ({ text: l, size: 8.5 })),
    { text: `Mobile: ${INVOICE_SUPPLIER.mobile}` },
    { text: `GSTIN: ${INVOICE_SUPPLIER.gstin}` },
    { text: `Email: ${INVOICE_SUPPLIER.email}` },
  ], [
    [{ label: 'Invoice No.', value: inv.invoice_no }, { label: 'Dated', value: dateStr(inv.invoice_date) }],
    [{ label: 'Delivery Note' }, { label: 'Mode/Terms of Payment' }],
    [{ label: "Supplier's Ref." }, { label: 'Other Reference(s)' }],
    [{ label: "Buyer's Order No." }, { label: 'Dated' }],
  ]);

  // ─── Buyer + despatch details ──────────────────────────────────────────────
  headerBlock([
    { text: 'Buyer', bold: true, size: 8.5 },
    { text: party.name || '-', bold: true, size: 9.5 },
    ...[
      party.address1,
      party.address2,
      [party.city, party.state, party.pincode].filter(Boolean).join(', '),
      party.gstin ? `GSTIN : ${party.gstin}` : '',
      inv.place_of_supply ? `Place of Supply : ${inv.place_of_supply}` : '',
      party.email ? `Email : ${party.email}` : '',
      party.phone ? `Phone : ${party.phone}` : '',
    ]
      .filter((l: string) => l && String(l).trim())
      .map((l: string) => ({ text: String(l), size: 8.5 })),
  ], [
    [{ label: 'Despatch Document No.' }, { label: 'Dated' }],
    [{ label: 'Despatched through' }, { label: 'Destination' }],
    [{ label: 'Terms of Delivery' }],
  ]);

  // ─── Item table heading ────────────────────────────────────────────────────
  ['Sl No.', 'Description of Goods', 'Quantity', 'Rate', 'per', 'Amount'].forEach((h, i) => {
    write(r, i + 1, h, { size: 8.5, h: 'center', wrap: true });
  });
  outline(r, C_SL, r, LAST_COL);
  columnRules(r);
  height(r, 26);
  r++;

  // ─── Items ─────────────────────────────────────────────────────────────────
  const bodyStart = r;

  for (const it of inv.items) {
    const unit = String(it.unit || '').trim();
    const lines = Math.max(1, Math.ceil(String(it.description).length / DESC_CHARS_PER_LINE));

    write(r, C_SL, it.line_no, { h: 'center', v: 'top' });
    write(r, C_DESC, it.description, { bold: true, v: 'top', wrap: true });
    write(r, C_QTY, Number(it.quantity), { bold: true, h: 'right', v: 'top', numFmt: qtyFmt(it.quantity, unit) });
    write(r, C_RATE, Number(it.rate), { h: 'right', v: 'top', numFmt: MONEY_FMT });
    write(r, C_PER, unit, { h: 'center', v: 'top' });
    write(r, C_AMT, Number(it.amount), { bold: true, h: 'right', v: 'top', numFmt: MONEY_FMT });
    height(r, Math.max(15, lines * 12 + 3));
    r++;

    if (it.hsn_sac) {
      write(r, C_DESC, `(SAC CODE: ${it.hsn_sac})`, { size: 7.5, v: 'top' });
      height(r, 13);
      r++;
    }
  }

  // ─── Discount, OUTPUT tax, round off ───────────────────────────────────────
  height(r, 10);
  r++;
  for (const l of ledgerLines(inv)) {
    write(r, C_DESC, l.label, { bold: true, italic: true, h: 'right' });
    if (l.percent) write(r, C_PER, '%', { h: 'center' });
    write(r, C_AMT, l.amount, { h: 'right', numFmt: SIGNED_FMT });
    height(r, 15);
    r++;
  }

  // Blank ruled rows: the gap between the charges and Total.
  while (r - bodyStart < MIN_BODY_ROWS) {
    height(r, 15);
    r++;
  }
  for (let row = bodyStart; row < r; row++) columnRules(row);

  // ─── Total ─────────────────────────────────────────────────────────────────
  write(r, C_DESC, 'Total', { h: 'right' });
  const tq = totalQuantity(inv);
  if (tq) write(r, C_QTY, tq.quantity, { bold: true, h: 'right', numFmt: qtyFmt(tq.quantity, tq.unit) });
  write(r, C_AMT, Number(inv.total_amount), { bold: true, size: 10.5, h: 'right', numFmt: MONEY_FMT });
  outline(r, C_SL, r, LAST_COL);
  columnRules(r);
  height(r, 18);
  r++;

  // ─── Amount in words ───────────────────────────────────────────────────────
  write(r, C_SL, 'Amount Chargeable (in words)', { size: 8 }, C_PER);
  write(r, C_AMT, 'E. & O.E', { size: 8, italic: true, h: 'right' });
  height(r, 14);
  r++;
  write(r, C_SL, `Rs. ${numberToWordsINR(inv.total_amount)} ONLY`, { bold: true, size: 10 }, LAST_COL);
  height(r, 16);
  r += 2;

  // ─── GST slab summary (only worth printing when slabs differ) ──────────────
  if (inv.breakup && inv.breakup.length > 1) {
    // [label, first col, last col] — the rate takes A:B, the last money column E:F
    const heads: Array<[string, number, number]> = isIntra
      ? [['GST Rate', C_SL, C_DESC], ['Taxable Value', C_QTY, C_QTY], ['CGST', C_RATE, C_RATE], ['SGST', C_PER, LAST_COL]]
      : [['GST Rate', C_SL, C_DESC], ['Taxable Value', C_QTY, C_QTY], ['IGST', C_RATE, LAST_COL]];

    const summaryRow = (vals: Array<string | number>, bold: boolean) => {
      heads.forEach(([, c1, c2], i) => {
        write(r, c1, vals[i], { bold, size: 8.5, h: i === 0 ? 'left' : 'right', numFmt: i === 0 ? undefined : MONEY_FMT }, c2);
        outline(r, c1, r, c2);
      });
      height(r, 14);
      r++;
    };

    summaryRow(heads.map(([h]) => h), true);
    for (const b of inv.breakup) {
      summaryRow(isIntra
        ? [`${Number(b.gst_rate)}%`, Number(b.taxable_amount), Number(b.cgst_amount), Number(b.sgst_amount)]
        : [`${Number(b.gst_rate)}%`, Number(b.taxable_amount), Number(b.igst_amount)], false);
    }
    summaryRow(isIntra
      ? ['Total', Number(inv.taxable_amount), Number(inv.cgst_amount), Number(inv.sgst_amount)]
      : ['Total', Number(inv.taxable_amount), Number(inv.igst_amount)], true);
    r++;
  }

  // ─── Remarks: notes + bank details ─────────────────────────────────────────
  write(r, C_SL, 'Remarks:', { size: 8, italic: true }, LAST_COL);
  r++;
  if (inv.notes && String(inv.notes).trim()) {
    const notes = String(inv.notes).trim();
    const lines = notes.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / 95)), 0);
    write(r, C_SL, notes, { wrap: true, v: 'top' }, LAST_COL);
    height(r, Math.max(14, lines * 12 + 2));
    r++;
  }
  for (const runs of bankLines()) {
    const c = write(r, C_SL, null, {}, LAST_COL);
    c.value = { richText: runs.map(([text, bold]) => ({ text, font: { name: FONT, size: 9, bold } })) };
    height(r, 13);
    r++;
  }
  r++;

  // ─── Declaration (A:B) + signature box (C:F) ───────────────────────────────
  const signTop = r;
  write(r, C_SL, 'Declaration', { size: 8 }, C_DESC);
  write(r, C_QTY, `for ${INVOICE_SUPPLIER.name}`, { bold: true, size: 8.5, h: 'right' }, LAST_COL);
  height(r, 14);
  r++;
  write(r, C_SL, DECLARATION, { size: 8, wrap: true, v: 'top' }, C_DESC, r + 1);
  height(r, 14);
  height(r + 1, 14);
  r += 2;
  write(r, C_QTY, 'Authorised Signatory', { size: 8, h: 'right', v: 'bottom' }, LAST_COL);
  height(r, 18);
  outline(signTop, C_QTY, r, LAST_COL);

  // ─── Outer frame, drawn last so its heavier edge wins ──────────────────────
  outline(frameTop, C_SL, r, LAST_COL, MEDIUM);
  r++;

  write(r, C_SL, 'This is a Computer Generated Invoice', { size: 8, h: 'center' }, LAST_COL);
  ws.pageSetup.printArea = `A1:F${r}`;

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}
