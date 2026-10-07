/**
 * PDF renderer for the standalone Tax Invoice module.
 *
 * Laid out like the Tally invoice parties already receive: one ruled frame;
 * boxed cells for the supplier, buyer and references; an item table whose
 * column rules run on past the tax and round-off rows, leaving a gap before
 * the Total row; then amount in words, remarks (bank details), declaration
 * and signature.
 *
 * Uses PDFKit's built-in Helvetica (no font files to ship). That font has no
 * glyph for the rupee sign U+20B9, so money is written as "Rs." — printing the
 * symbol would emit a blank box in most viewers.
 */

import PDFDocument from 'pdfkit';
import { INVOICE_SUPPLIER, INVOICE_BANK, numberToWordsINR } from './invoiceConstants';

export interface PdfInvoice {
  invoice_no: string;
  invoice_date: string;
  place_of_supply?: string | null;
  gst_mode: 'cgst_sgst' | 'igst';
  party_snapshot: any;
  items: Array<{
    line_no: number;
    description: string;
    hsn_sac?: string | null;
    quantity: number;
    unit?: string | null;
    rate: number;
    gst_rate: number;
    amount: number;
  }>;
  breakup?: Array<{
    gst_rate: number;
    taxable_amount: number;
    cgst_amount: number;
    sgst_amount: number;
    igst_amount: number;
  }>;
  subtotal: number;
  discount: number;
  taxable_amount: number;
  cgst_amount: number;
  sgst_amount: number;
  igst_amount: number;
  round_off: number;
  total_amount: number;
  notes?: string | null;
  is_cancelled?: boolean;
}

// ─── Page geometry (A4 portrait, points) ─────────────────────────────────────
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MX = 36;                       // left / right margin
const W = PAGE_W - MX * 2;           // frame width
const FRAME_BOTTOM = PAGE_H - 36;    // lowest the frame may reach; the footer line sits below
const PAD = 4;                       // inner cell padding
const OUTER_LW = 1.2;                // frame rule
const INNER_LW = 0.6;                // every other rule

const HEADER_LEFT_W = W * 0.52;      // supplier / buyer column; references take the rest
const HEADER_H = 24;                 // item table heading row
const TOTAL_H = 20;                  // item table Total row
const CONTINUED_H = 16;              // "continued..." strip at the foot of a broken page
const MIN_BODY_H = 260;              // item area height above Total: the Tally-style gap
const SIGN_SPLIT = W * 0.52;         // declaration | signature box

/** Item table columns. Description takes whatever the others leave. */
const COLS: Array<{ label: string; w: number; align: 'left' | 'right' | 'center' }> = [
  { label: 'Sl\nNo.',               w: 26, align: 'center' },
  { label: 'Description of Goods', w: 0,  align: 'left' },
  { label: 'Quantity',              w: 64, align: 'right' },
  { label: 'Rate',                  w: 62, align: 'right' },
  { label: 'per',                   w: 34, align: 'center' },
  { label: 'Amount',                w: 88, align: 'right' },
];
COLS[1].w = W - COLS.reduce((s, c) => s + c.w, 0);

const C_SL = 0, C_DESC = 1, C_QTY = 2, C_RATE = 3, C_PER = 4, C_AMT = 5;

function colX(index: number): number {
  let x = MX;
  for (let i = 0; i < index; i++) x += COLS[i].w;
  return x;
}

const money = (n: number): string =>
  Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Tally prints negatives as "(-)0.40". */
const signedMoney = (n: number): string => (Number(n) < 0 ? `(-)${money(-Number(n))}` : money(n));

const qty = (n: number): string => {
  const v = Number(n || 0);
  // Show 45 rather than 45.000, but keep real fractions (1.5, 0.25)
  return Number.isInteger(v) ? String(v) : String(parseFloat(v.toFixed(3)));
};

/** 18 -> "18%", 2.5 -> "2.5%". */
const pct = (n: number): string => `${parseFloat(Number(n).toFixed(3))}%`;

/**
 * "2026-09-29" -> "29-09-2026".
 *
 * The plain date string is split directly rather than fed through `new Date`,
 * which would parse it as UTC midnight and then render the previous day on any
 * server west of UTC.
 */
const dateStr = (value: any): string => {
  const s = String(value ?? '');
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;

  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
};

// ─── Drawing primitives ──────────────────────────────────────────────────────

type Doc = PDFKit.PDFDocument;
type Align = 'left' | 'right' | 'center';

function hline(doc: Doc, x1: number, x2: number, y: number, lw = INNER_LW): void {
  doc.save().lineWidth(lw).moveTo(x1, y).lineTo(x2, y).stroke().restore();
}

function vline(doc: Doc, x: number, y1: number, y2: number, lw = INNER_LW): void {
  doc.save().lineWidth(lw).moveTo(x, y1).lineTo(x, y2).stroke().restore();
}

function box(doc: Doc, x: number, y: number, w: number, h: number, lw = INNER_LW): void {
  doc.save().lineWidth(lw).rect(x, y, w, h).stroke().restore();
}

function measure(doc: Doc, text: string, font: string, size: number, width: number): number {
  return doc.font(font).fontSize(size).heightOfString(text || ' ', { width });
}

/** Writes text at an absolute position and returns its height. */
function put(doc: Doc, text: string, x: number, y: number, width: number,
  font = 'Helvetica', size = 9, align: Align = 'left'): number {
  doc.font(font).fontSize(size).text(text, x, y, { width, align });
  return measure(doc, text, font, size, width);
}

/** One line built from bold / regular runs, e.g. "A/C: 5020..., IFSC: HDFC...". */
function putRuns(doc: Doc, runs: Array<[string, boolean]>, x: number, y: number, size = 9): void {
  let cx = x;
  for (const [text, bold] of runs) {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size);
    doc.text(text, cx, y, { lineBreak: false });
    cx += doc.widthOfString(text);
  }
}

// ─── Header blocks (supplier / buyer on the left, reference grid on the right) ─

type TextLine = { text: string; font?: string; size?: number; gap?: number };
type RefCell = { label: string; value?: string };

const REF_LABEL_SIZE = 8;
const REF_VALUE_SIZE = 9;
const REF_MIN_H = 24;

function refCellHeight(doc: Doc, cell: RefCell, width: number): number {
  const inner = width - PAD * 2;
  let h = PAD + measure(doc, cell.label, 'Helvetica', REF_LABEL_SIZE, inner);
  if (cell.value) h += 2 + measure(doc, cell.value, 'Helvetica-Bold', REF_VALUE_SIZE, inner);
  return Math.max(REF_MIN_H, h + PAD);
}

function drawRefCell(doc: Doc, cell: RefCell, x: number, y: number, w: number, h: number): void {
  box(doc, x, y, w, h);
  const inner = w - PAD * 2;
  const lh = put(doc, cell.label, x + PAD, y + PAD, inner, 'Helvetica', REF_LABEL_SIZE);
  if (cell.value) put(doc, cell.value, x + PAD, y + PAD + lh + 2, inner, 'Helvetica-Bold', REF_VALUE_SIZE);
}

/**
 * A boxed text block on the left and a grid of reference cells on the right
 * (rows of one or two cells). The two sides are stretched to the same height;
 * the right side's last row takes up any slack. Returns the bottom y.
 */
function drawHeaderBlock(doc: Doc, y: number, lines: TextLine[], rows: RefCell[][]): number {
  const leftInner = HEADER_LEFT_W - PAD * 2;
  const rightX = MX + HEADER_LEFT_W;
  const rightW = W - HEADER_LEFT_W;
  const halfW = rightW / 2;

  let leftH = PAD * 2;
  for (const l of lines) leftH += (l.gap || 0) + measure(doc, l.text, l.font || 'Helvetica', l.size || 9, leftInner);

  const rowH = rows.map((row) => Math.max(...row.map((c) => refCellHeight(doc, c, row.length === 1 ? rightW : halfW))));
  const rightH = rowH.reduce((s, h) => s + h, 0);
  if (leftH > rightH) rowH[rowH.length - 1] += leftH - rightH;
  const h = Math.max(leftH, rightH);

  box(doc, MX, y, HEADER_LEFT_W, h);
  let ly = y + PAD;
  for (const l of lines) {
    ly += l.gap || 0;
    ly += put(doc, l.text, MX + PAD, ly, leftInner, l.font || 'Helvetica', l.size || 9);
  }

  let ry = y;
  rows.forEach((row, i) => {
    if (row.length === 1) {
      drawRefCell(doc, row[0], rightX, ry, rightW, rowH[i]);
    } else {
      drawRefCell(doc, row[0], rightX, ry, halfW, rowH[i]);
      drawRefCell(doc, row[1], rightX + halfW, ry, halfW, rowH[i]);
    }
    ry += rowH[i];
  });

  return y + h;
}

// ─── Item table rows ─────────────────────────────────────────────────────────

type BodyRow = { h: number; draw: (doc: Doc, y: number) => void };

const ITEM_SIZE = 9;
const SAC_SIZE = 7.5;
const CHARGE_H = 16;

function itemRow(doc: Doc, it: PdfInvoice['items'][number]): BodyRow {
  const descW = COLS[C_DESC].w - PAD * 2;
  const sac = it.hsn_sac ? `(SAC CODE: ${it.hsn_sac})` : '';
  const descH = measure(doc, it.description, 'Helvetica-Bold', ITEM_SIZE, descW);
  const sacH = sac ? 2 + measure(doc, sac, 'Helvetica', SAC_SIZE, descW) : 0;
  const unit = it.unit ? String(it.unit) : '';

  return {
    h: PAD + descH + sacH + PAD + 2,
    draw: (d, y) => {
      const ty = y + PAD;
      put(d, String(it.line_no), colX(C_SL) + PAD, ty, COLS[C_SL].w - PAD * 2, 'Helvetica', ITEM_SIZE, 'center');
      put(d, it.description, colX(C_DESC) + PAD, ty, descW, 'Helvetica-Bold', ITEM_SIZE);
      if (sac) put(d, sac, colX(C_DESC) + PAD, ty + descH + 2, descW, 'Helvetica', SAC_SIZE);
      putQty(d, qty(it.quantity), unit, ty, 'Helvetica-Bold');
      put(d, money(it.rate), colX(C_RATE) + PAD, ty, COLS[C_RATE].w - PAD * 2, 'Helvetica', ITEM_SIZE, 'right');
      put(d, unit, colX(C_PER) + 2, ty, COLS[C_PER].w - 4, 'Helvetica', ITEM_SIZE, 'center');
      put(d, money(it.amount), colX(C_AMT) + PAD, ty, COLS[C_AMT].w - PAD * 2, 'Helvetica-Bold', ITEM_SIZE, 'right');
    },
  };
}

/** "43 HBL" right-aligned in the Quantity column: the number bold, the unit not. */
function putQty(doc: Doc, num: string, unit: string, y: number, numFont: string, size = ITEM_SIZE): void {
  const right = colX(C_QTY) + COLS[C_QTY].w - PAD;
  const unitText = unit ? ` ${unit}` : '';
  const unitW = doc.font('Helvetica').fontSize(size).widthOfString(unitText);
  const numW = doc.font(numFont).fontSize(size).widthOfString(num);
  doc.font(numFont).fontSize(size).text(num, right - unitW - numW, y, { lineBreak: false });
  if (unitText) doc.font('Helvetica').fontSize(size).text(unitText, right - unitW, y, { lineBreak: false });
}

/** Ledger lines under the items: discount, OUTPUT tax, round off. */
function chargeRow(label: string, amount: string, per = ''): BodyRow {
  return {
    h: CHARGE_H,
    draw: (d, y) => {
      const ty = y + 3;
      put(d, label, colX(C_DESC) + PAD, ty, COLS[C_DESC].w - PAD * 2, 'Helvetica-BoldOblique', ITEM_SIZE, 'right');
      if (per) put(d, per, colX(C_PER) + 2, ty, COLS[C_PER].w - 4, 'Helvetica', ITEM_SIZE, 'center');
      put(d, amount, colX(C_AMT) + PAD, ty, COLS[C_AMT].w - PAD * 2, 'Helvetica', ITEM_SIZE, 'right');
    },
  };
}

function spacerRow(h: number): BodyRow {
  return { h, draw: () => undefined };
}

export type LedgerLine = { label: string; amount: number; percent: boolean };

/**
 * The lines printed under the items, Tally style: discount, then OUTPUT tax
 * per GST slab, then round off. Shared with the Excel renderer.
 */
export function ledgerLines(inv: PdfInvoice): LedgerLine[] {
  const isIntra = inv.gst_mode === 'cgst_sgst';
  const lines: LedgerLine[] = [];

  if (Number(inv.discount) > 0) lines.push({ label: 'LESS : DISCOUNT', amount: -Number(inv.discount), percent: false });

  const slabs = (inv.breakup || []).filter((b) => Number(b.gst_rate) > 0);
  if (slabs.length) {
    for (const b of slabs) {
      if (isIntra) {
        const half = Number(b.gst_rate) / 2;
        lines.push({ label: `OUTPUT CGST ${pct(half)}`, amount: Number(b.cgst_amount), percent: true });
        lines.push({ label: `OUTPUT SGST ${pct(half)}`, amount: Number(b.sgst_amount), percent: true });
      } else {
        lines.push({ label: `OUTPUT IGST ${pct(b.gst_rate)}`, amount: Number(b.igst_amount), percent: true });
      }
    }
  } else if (isIntra) {
    // No slab breakup supplied: fall back to the invoice totals.
    if (Number(inv.cgst_amount)) lines.push({ label: 'OUTPUT CGST', amount: Number(inv.cgst_amount), percent: false });
    if (Number(inv.sgst_amount)) lines.push({ label: 'OUTPUT SGST', amount: Number(inv.sgst_amount), percent: false });
  } else if (Number(inv.igst_amount)) {
    lines.push({ label: 'OUTPUT IGST', amount: Number(inv.igst_amount), percent: false });
  }

  lines.push({ label: 'ROUND OFF', amount: Number(inv.round_off || 0), percent: false });
  return lines;
}

/** Total quantity for the Total row, but only when every line uses the same unit. */
export function totalQuantity(inv: PdfInvoice): { quantity: number; unit: string } | null {
  const units = new Set(inv.items.map((it) => String(it.unit || '').trim().toUpperCase()));
  if (units.size !== 1) return null;
  const sum = inv.items.reduce((s, it) => s + Number(it.quantity || 0), 0);
  return { quantity: parseFloat(sum.toFixed(3)), unit: String(inv.items[0].unit || '').trim() };
}

function buildBodyRows(doc: Doc, inv: PdfInvoice): BodyRow[] {
  return [
    ...inv.items.map((it) => itemRow(doc, it)),
    spacerRow(12),
    ...ledgerLines(inv).map((l) => chargeRow(l.label, signedMoney(l.amount), l.percent ? '%' : '')),
  ];
}

// ─── Footer (inside the frame, below the Total row) ──────────────────────────

const FOOT_LINE = 11;
const SIGN_H = 64;
export const DECLARATION =
  'We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.';

/** Bank details as bold-label / value runs, one array per printed line. */
export function bankLines(): Array<Array<[string, boolean]>> {
  return [
    [['BANK DETAILS', true], [`: ${INVOICE_BANK.accountName.toUpperCase()},`, false]],
    [['A/C', true], [`: ${INVOICE_BANK.accountNo}, `, false], ['IFSC', true], [`: ${INVOICE_BANK.ifsc},`, false]],
    [['BRANCH', true], [`: ${INVOICE_BANK.branch.toUpperCase()}, `, false],
      ['A/C TYPE', true], [`: ${INVOICE_BANK.accountType.toUpperCase()}`, false]],
  ];
}

function gstSummaryHeight(inv: PdfInvoice): number {
  const n = (inv.breakup || []).length;
  return n > 1 ? 8 + (n + 2) * 15 : 0;
}

function wordsText(inv: PdfInvoice): string {
  return `Rs. ${numberToWordsINR(inv.total_amount)} ONLY`;
}

function footerHeight(doc: Doc, inv: PdfInvoice): number {
  const inner = W - PAD * 2;
  const words = PAD + 10 + 2 + measure(doc, wordsText(inv), 'Helvetica-Bold', 9.5, inner) + 6;
  const notes = inv.notes && String(inv.notes).trim()
    ? measure(doc, String(inv.notes).trim(), 'Helvetica', 9, inner) + 3 : 0;
  const remarks = 14 + 11 + notes + bankLines().length * FOOT_LINE + 10;
  return words + gstSummaryHeight(inv) + remarks + SIGN_H;
}

function drawGstSummary(doc: Doc, inv: PdfInvoice, y: number): number {
  const isIntra = inv.gst_mode === 'cgst_sgst';
  const breakup = inv.breakup || [];
  const heads = isIntra
    ? ['GST Rate', 'Taxable Value', 'CGST', 'SGST', 'Total Tax Amount']
    : ['GST Rate', 'Taxable Value', 'IGST', 'Total Tax Amount'];
  const rowOf = (b: { gst_rate?: number; taxable_amount: number; cgst_amount: number; sgst_amount: number; igst_amount: number }, label: string) => {
    const tax = isIntra ? Number(b.cgst_amount) + Number(b.sgst_amount) : Number(b.igst_amount);
    return isIntra
      ? [label, money(b.taxable_amount), money(b.cgst_amount), money(b.sgst_amount), money(tax)]
      : [label, money(b.taxable_amount), money(b.igst_amount), money(tax)];
  };
  const totals = {
    taxable_amount: Number(inv.taxable_amount),
    cgst_amount: Number(inv.cgst_amount),
    sgst_amount: Number(inv.sgst_amount),
    igst_amount: Number(inv.igst_amount),
  };
  const body = [
    ...breakup.map((b) => rowOf(b, pct(b.gst_rate))),
    rowOf(totals, 'Total'),
  ];

  const x0 = MX + PAD;
  const tw = W - PAD * 2;
  const cw = tw / heads.length;
  const rh = 15;
  let ty = y + 4;

  const drawRow = (vals: string[], bold: boolean) => {
    vals.forEach((v, i) => {
      box(doc, x0 + cw * i, ty, cw, rh);
      put(doc, v, x0 + cw * i + PAD, ty + 4, cw - PAD * 2, bold ? 'Helvetica-Bold' : 'Helvetica', 8,
        i === 0 ? 'left' : 'right');
    });
    ty += rh;
  };

  drawRow(heads, true);
  body.forEach((vals, i) => drawRow(vals, i === body.length - 1));
  return y + gstSummaryHeight(inv);
}

/** Draws everything below the Total row. Returns the bottom of the frame. */
function drawFooter(doc: Doc, inv: PdfInvoice, top: number): number {
  const inner = W - PAD * 2;
  let y = top + PAD;

  put(doc, 'Amount Chargeable (in words)', MX + PAD, y, inner, 'Helvetica', 8);
  put(doc, 'E. & O.E', MX + PAD, y, inner, 'Helvetica-Oblique', 8, 'right');
  y += 12;
  y += put(doc, wordsText(inv), MX + PAD, y, inner, 'Helvetica-Bold', 9.5) + 6;

  if ((inv.breakup || []).length > 1) y = drawGstSummary(doc, inv, y);

  y += 14;
  put(doc, 'Remarks:', MX + PAD, y, inner, 'Helvetica-Oblique', 8);
  y += 11;
  if (inv.notes && String(inv.notes).trim()) {
    y += put(doc, String(inv.notes).trim(), MX + PAD, y, inner, 'Helvetica', 9) + 3;
  }
  for (const runs of bankLines()) {
    putRuns(doc, runs, MX + PAD, y);
    y += FOOT_LINE;
  }
  y += 10;

  // Declaration (left) and signature box (right)
  const declW = SIGN_SPLIT - PAD * 2;
  put(doc, 'Declaration', MX + PAD, y + PAD, declW, 'Helvetica', 8);
  put(doc, DECLARATION, MX + PAD, y + PAD + 11, declW, 'Helvetica', 8);

  const sx = MX + SIGN_SPLIT;
  const sw = W - SIGN_SPLIT;
  hline(doc, sx, MX + W, y);
  vline(doc, sx, y, y + SIGN_H);
  put(doc, `for ${INVOICE_SUPPLIER.name}`, sx + PAD, y + PAD, sw - PAD * 2, 'Helvetica-Bold', 8.5, 'right');
  put(doc, 'Authorised Signatory', sx + PAD, y + SIGN_H - 14, sw - PAD * 2, 'Helvetica', 8, 'right');

  return y + SIGN_H;
}

// ─── Page furniture ──────────────────────────────────────────────────────────

/** Title above the frame. Returns where the frame starts. */
function drawTitle(doc: Doc, inv: PdfInvoice, continued: boolean): number {
  put(doc, 'TAX INVOICE', MX, 22, W, 'Helvetica-Bold', 13, 'center');
  let y = 38;
  if (continued) {
    put(doc, `(continued)  Invoice No. ${inv.invoice_no}`, MX, y, W, 'Helvetica', 8, 'center');
    y += 12;
  }
  if (inv.is_cancelled) {
    doc.fillColor('#b91c1c');
    put(doc, '** CANCELLED **', MX, y, W, 'Helvetica-Bold', 10, 'center');
    doc.fillColor('#000');
    y += 14;
  }
  return y + 4;
}

function drawTableHeading(doc: Doc, y: number): number {
  COLS.forEach((c, i) => {
    const lines = c.label.split('\n').length;
    const size = lines > 1 ? 7.5 : 8.5;
    const th = measure(doc, c.label, 'Helvetica', size, c.w - 4);
    put(doc, c.label, colX(i) + 2, y + (HEADER_H - th) / 2, c.w - 4, 'Helvetica', size, 'center');
  });
  hline(doc, MX, MX + W, y + HEADER_H);
  return y + HEADER_H;
}

function drawColumnRules(doc: Doc, top: number, bottom: number): void {
  for (let i = 1; i < COLS.length; i++) vline(doc, colX(i), top, bottom);
}

function drawComputerGenerated(doc: Doc, frameBottom: number): void {
  put(doc, 'This is a Computer Generated Invoice', MX, frameBottom + 6, W, 'Helvetica', 8, 'center');
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * Renders the invoice and resolves with the finished PDF bytes.
 * Buffering to memory is fine here — a tax invoice is a few KB at most.
 */
export function renderInvoicePdf(inv: PdfInvoice): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      // Bottom margin 0: every position is absolute, and PDFKit must never
      // break a page on its own when text lands near the foot.
      const doc = new PDFDocument({ size: 'A4', margins: { top: 20, bottom: 0, left: MX, right: MX } });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      drawInvoice(doc, inv);

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function drawInvoice(doc: Doc, inv: PdfInvoice): void {
  const party = inv.party_snapshot || {};
  doc.strokeColor('#000').fillColor('#000');

  let frameTop = drawTitle(doc, inv, false);

  // ─── Supplier + references ─────────────────────────────────────────────────
  const supplierLines: TextLine[] = [
    { text: INVOICE_SUPPLIER.name, font: 'Helvetica-Bold', size: 11 },
    ...INVOICE_SUPPLIER.addressLines.map((l, i) => ({ text: l, size: 8.5, gap: i === 0 ? 3 : 0 })),
    { text: `Mobile: ${INVOICE_SUPPLIER.mobile}`, gap: 2 },
    { text: `GSTIN: ${INVOICE_SUPPLIER.gstin}` },
    { text: `Email: ${INVOICE_SUPPLIER.email}` },
  ];
  let y = drawHeaderBlock(doc, frameTop, supplierLines, [
    [{ label: 'Invoice No.', value: inv.invoice_no }, { label: 'Dated', value: dateStr(inv.invoice_date) }],
    [{ label: 'Delivery Note' }, { label: 'Mode/Terms of Payment' }],
    [{ label: "Supplier's Ref." }, { label: 'Other Reference(s)' }],
    [{ label: "Buyer's Order No." }, { label: 'Dated' }],
  ]);

  // ─── Buyer + despatch details ──────────────────────────────────────────────
  const buyerLines: TextLine[] = [
    { text: 'Buyer', font: 'Helvetica-Bold', size: 8.5 },
    { text: party.name || '-', font: 'Helvetica-Bold', size: 9.5, gap: 3 },
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
  ];
  y = drawHeaderBlock(doc, y, buyerLines, [
    [{ label: 'Despatch Document No.' }, { label: 'Dated' }],
    [{ label: 'Despatched through' }, { label: 'Destination' }],
    [{ label: 'Terms of Delivery' }],
  ]);

  // ─── Item table ────────────────────────────────────────────────────────────
  const rows = buildBodyRows(doc, inv);
  const footH = footerHeight(doc, inv);

  let tableTop = y;
  let bodyTop = drawTableHeading(doc, tableTop);
  y = bodyTop;

  const closeBrokenPage = () => {
    const bottom = FRAME_BOTTOM;
    drawColumnRules(doc, tableTop, bottom);
    put(doc, 'continued ...', colX(C_DESC) + PAD, bottom - CONTINUED_H + 4, COLS[C_DESC].w - PAD * 2,
      'Helvetica-Oblique', 8, 'right');
    box(doc, MX, frameTop, W, bottom - frameTop, OUTER_LW);
    drawComputerGenerated(doc, bottom);
    doc.addPage();
    frameTop = drawTitle(doc, inv, true);
    tableTop = frameTop;
    bodyTop = drawTableHeading(doc, tableTop);
    y = bodyTop;
  };

  for (const row of rows) {
    if (y + row.h > FRAME_BOTTOM - CONTINUED_H) closeBrokenPage();
    row.draw(doc, y);
    y += row.h;
  }

  // The Total row and footer travel together; move them over if they won't fit.
  if (y + TOTAL_H + footH > FRAME_BOTTOM) closeBrokenPage();

  // Leave the Tally-style gap above Total, as far as the page allows.
  const totalY = Math.max(y, Math.min(bodyTop + MIN_BODY_H, FRAME_BOTTOM - TOTAL_H - footH));

  drawColumnRules(doc, tableTop, totalY + TOTAL_H);
  hline(doc, MX, MX + W, totalY);
  hline(doc, MX, MX + W, totalY + TOTAL_H);

  const ty = totalY + 6;
  put(doc, 'Total', colX(C_DESC) + PAD, ty, COLS[C_DESC].w - PAD * 2, 'Helvetica', ITEM_SIZE, 'right');
  const tq = totalQuantity(inv);
  if (tq) putQty(doc, qty(tq.quantity), tq.unit, ty, 'Helvetica-Bold');
  put(doc, money(inv.total_amount), colX(C_AMT) + PAD, totalY + 5, COLS[C_AMT].w - PAD * 2,
    'Helvetica-Bold', 10.5, 'right');

  // ─── Words, remarks, declaration, signature ────────────────────────────────
  const frameBottom = drawFooter(doc, inv, totalY + TOTAL_H);
  box(doc, MX, frameTop, W, frameBottom - frameTop, OUTER_LW);
  drawComputerGenerated(doc, frameBottom);
}
