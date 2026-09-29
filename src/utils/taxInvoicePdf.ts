/**
 * PDF renderer for the standalone Tax Invoice module.
 *
 * Uses PDFKit's built-in Helvetica (no font files to ship). That font has no
 * glyph for the rupee sign U+20B9, so money is prefixed with "Rs." throughout —
 * printing the symbol would emit a blank box in most viewers.
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

const PAGE_MARGIN = 40;
const PAGE_WIDTH = 595.28;             // A4 portrait, points
const CONTENT_W = PAGE_WIDTH - PAGE_MARGIN * 2;
const BOTTOM_LIMIT = 780;              // start a new page past this y

const money = (n: number): string =>
  Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const qty = (n: number): string => {
  const v = Number(n || 0);
  // Show 45 rather than 45.000, but keep real fractions (1.5, 0.25)
  return Number.isInteger(v) ? String(v) : String(parseFloat(v.toFixed(3)));
};

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

/** Item table geometry: [x offset, width, alignment]. Widths sum to CONTENT_W. */
const COLS: Array<{ key: string; label: string; w: number; align: 'left' | 'right' | 'center' }> = [
  { key: 'sr',   label: '#',      w: 22, align: 'center' },
  { key: 'desc', label: 'Description', w: 180, align: 'left' },
  { key: 'hsn',  label: 'HSN/SAC', w: 55, align: 'center' },
  { key: 'qty',  label: 'Qty',     w: 45, align: 'right' },
  { key: 'unit', label: 'Unit',    w: 38, align: 'center' },
  { key: 'rate', label: 'Rate',    w: 60, align: 'right' },
  { key: 'gst',  label: 'GST%',    w: 38, align: 'right' },
  { key: 'amt',  label: 'Amount',  w: CONTENT_W - (22 + 180 + 55 + 45 + 38 + 60 + 38), align: 'right' },
];

function colX(index: number): number {
  let x = PAGE_MARGIN;
  for (let i = 0; i < index; i++) x += COLS[i].w;
  return x;
}

/**
 * Renders the invoice and resolves with the finished PDF bytes.
 * Buffering to memory is fine here — a tax invoice is a few KB at most.
 */
export function renderInvoicePdf(inv: PdfInvoice): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: PAGE_MARGIN });
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

function drawInvoice(doc: PDFKit.PDFDocument, inv: PdfInvoice): void {
  const party = inv.party_snapshot || {};
  const isIntra = inv.gst_mode === 'cgst_sgst';

  // ─── Title ─────────────────────────────────────────────────────────────────
  doc.font('Helvetica-Bold').fontSize(16).text('TAX INVOICE', PAGE_MARGIN, PAGE_MARGIN, {
    width: CONTENT_W, align: 'center',
  });

  if (inv.is_cancelled) {
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#b91c1c')
      .text('** CANCELLED **', PAGE_MARGIN, doc.y + 2, { width: CONTENT_W, align: 'center' })
      .fillColor('#000');
  }

  let y = doc.y + 10;

  // ─── Supplier ──────────────────────────────────────────────────────────────
  doc.font('Helvetica-Bold').fontSize(12).text(INVOICE_SUPPLIER.name, PAGE_MARGIN, y);
  y = doc.y + 2;
  doc.font('Helvetica').fontSize(9);
  for (const line of INVOICE_SUPPLIER.addressLines) {
    doc.text(line, PAGE_MARGIN, y);
    y = doc.y;
  }
  doc.text(`GSTIN: ${INVOICE_SUPPLIER.gstin}`, PAGE_MARGIN, y);
  y = doc.y;
  doc.text(`Mobile: ${INVOICE_SUPPLIER.mobile}   Email: ${INVOICE_SUPPLIER.email}`, PAGE_MARGIN, y);
  y = doc.y + 8;

  doc.moveTo(PAGE_MARGIN, y).lineTo(PAGE_MARGIN + CONTENT_W, y).stroke();
  y += 8;

  // ─── Bill-to + invoice meta, side by side ──────────────────────────────────
  const leftW = CONTENT_W * 0.58;
  const rightX = PAGE_MARGIN + leftW + 10;
  const rightW = CONTENT_W - leftW - 10;
  const blockTop = y;

  doc.font('Helvetica-Bold').fontSize(9).text('BILL TO', PAGE_MARGIN, y);
  y = doc.y + 2;
  doc.font('Helvetica-Bold').fontSize(10).text(party.name || '-', PAGE_MARGIN, y, { width: leftW });
  y = doc.y + 1;
  doc.font('Helvetica').fontSize(9);
  const partyLines = [
    party.address1,
    party.address2,
    [party.city, party.state, party.pincode].filter(Boolean).join(', '),
    party.gstin ? `GSTIN: ${party.gstin}` : '',
    party.email ? `Email: ${party.email}` : '',
    party.phone ? `Phone: ${party.phone}` : '',
  ].filter((l: string) => l && String(l).trim());
  for (const line of partyLines) {
    doc.text(String(line), PAGE_MARGIN, y, { width: leftW });
    y = doc.y;
  }
  const leftBottom = y;

  let ry = blockTop;
  const metaRow = (label: string, value: string) => {
    doc.font('Helvetica-Bold').fontSize(9).text(label, rightX, ry, { width: rightW * 0.45 });
    doc.font('Helvetica').fontSize(9).text(value, rightX + rightW * 0.45, ry, { width: rightW * 0.55 });
    ry = Math.max(doc.y, ry + 12);
  };
  metaRow('Invoice No:', inv.invoice_no);
  metaRow('Invoice Date:', dateStr(inv.invoice_date));
  if (inv.place_of_supply) metaRow('Place of Supply:', String(inv.place_of_supply));
  metaRow('Tax Type:', isIntra ? 'CGST + SGST' : 'IGST');

  y = Math.max(leftBottom, ry) + 10;

  // ─── Item table ────────────────────────────────────────────────────────────
  y = drawItemsTable(doc, inv, y);

  // ─── Totals block ──────────────────────────────────────────────────────────
  y = ensureSpace(doc, y, 150);

  const totalsX = PAGE_MARGIN + CONTENT_W * 0.55;
  const totalsW = CONTENT_W * 0.45;
  const labelW = totalsW * 0.55;
  const valueW = totalsW * 0.45;

  const totalRow = (label: string, value: string, bold = false) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
    doc.text(label, totalsX, y, { width: labelW, align: 'right' });
    doc.text(value, totalsX + labelW, y, { width: valueW, align: 'right' });
    y += 13;
  };

  totalRow('Subtotal', `Rs. ${money(inv.subtotal)}`);
  if (Number(inv.discount) > 0) totalRow('Discount', `- Rs. ${money(inv.discount)}`);
  totalRow('Taxable Value', `Rs. ${money(inv.taxable_amount)}`);
  if (isIntra) {
    totalRow('CGST', `Rs. ${money(inv.cgst_amount)}`);
    totalRow('SGST', `Rs. ${money(inv.sgst_amount)}`);
  } else {
    totalRow('IGST', `Rs. ${money(inv.igst_amount)}`);
  }
  if (Number(inv.round_off) !== 0) {
    const r = Number(inv.round_off);
    totalRow('Round Off', `${r < 0 ? '- ' : ''}Rs. ${money(Math.abs(r))}`);
  }

  doc.moveTo(totalsX, y).lineTo(PAGE_MARGIN + CONTENT_W, y).stroke();
  y += 4;
  totalRow('TOTAL', `Rs. ${money(inv.total_amount)}`, true);

  y += 4;
  doc.font('Helvetica-Bold').fontSize(9).text('Amount in words:', PAGE_MARGIN, y);
  doc.font('Helvetica').fontSize(9)
    .text(`${numberToWordsINR(inv.total_amount)} RUPEES ONLY`, PAGE_MARGIN, doc.y, { width: CONTENT_W * 0.52 });
  y = Math.max(y, doc.y) + 10;

  // ─── GST slab summary (only worth printing when slabs differ) ──────────────
  if (inv.breakup && inv.breakup.length > 1) {
    y = ensureSpace(doc, y, 80);
    y = drawGstSummary(doc, inv, y, isIntra);
  }

  // ─── Bank + signature ──────────────────────────────────────────────────────
  y = ensureSpace(doc, y, 110);
  doc.moveTo(PAGE_MARGIN, y).lineTo(PAGE_MARGIN + CONTENT_W, y).stroke();
  y += 8;

  doc.font('Helvetica-Bold').fontSize(9).text('Bank Details', PAGE_MARGIN, y);
  let by = doc.y + 2;
  doc.font('Helvetica').fontSize(9);
  for (const line of [
    `Account Holder: ${INVOICE_BANK.accountName}`,
    `Account No: ${INVOICE_BANK.accountNo}`,
    `IFSC: ${INVOICE_BANK.ifsc}`,
    `Branch: ${INVOICE_BANK.branch}`,
    `Account Type: ${INVOICE_BANK.accountType}`,
  ]) {
    doc.text(line, PAGE_MARGIN, by, { width: CONTENT_W * 0.55 });
    by = doc.y;
  }

  doc.font('Helvetica').fontSize(9)
    .text(`For ${INVOICE_SUPPLIER.name}`, PAGE_MARGIN + CONTENT_W * 0.6, y + 10, {
      width: CONTENT_W * 0.4, align: 'right',
    });
  doc.text('Authorised Signatory', PAGE_MARGIN + CONTENT_W * 0.6, y + 58, {
    width: CONTENT_W * 0.4, align: 'right',
  });

  y = Math.max(by, y + 75) + 8;

  if (inv.notes && String(inv.notes).trim()) {
    y = ensureSpace(doc, y, 40);
    doc.font('Helvetica-Bold').fontSize(8).text('Notes', PAGE_MARGIN, y);
    doc.font('Helvetica').fontSize(8).text(String(inv.notes), PAGE_MARGIN, doc.y, { width: CONTENT_W });
    y = doc.y + 6;
  }

  doc.font('Helvetica').fontSize(7).fillColor('#666')
    .text('This is a computer-generated invoice.', PAGE_MARGIN, y, { width: CONTENT_W, align: 'center' })
    .fillColor('#000');
}

/** Adds a page if `need` points won't fit below `y`. Returns the usable y. */
function ensureSpace(doc: PDFKit.PDFDocument, y: number, need: number): number {
  if (y + need > BOTTOM_LIMIT) {
    doc.addPage();
    return PAGE_MARGIN;
  }
  return y;
}

function drawTableHeader(doc: PDFKit.PDFDocument, y: number): number {
  const h = 18;
  doc.rect(PAGE_MARGIN, y, CONTENT_W, h).fillAndStroke('#f1f5f9', '#94a3b8');
  doc.fillColor('#000').font('Helvetica-Bold').fontSize(8);
  COLS.forEach((c, i) => {
    doc.text(c.label, colX(i) + 3, y + 5, { width: c.w - 6, align: c.align });
  });
  return y + h;
}

function drawItemsTable(doc: PDFKit.PDFDocument, inv: PdfInvoice, startY: number): number {
  let y = ensureSpace(doc, startY, 60);
  y = drawTableHeader(doc, y);

  doc.font('Helvetica').fontSize(8);

  for (const it of inv.items) {
    const descW = COLS[1].w - 6;
    const descH = doc.heightOfString(it.description, { width: descW });
    const rowH = Math.max(16, descH + 8);

    if (y + rowH > BOTTOM_LIMIT) {
      doc.addPage();
      y = PAGE_MARGIN;
      y = drawTableHeader(doc, y);
      doc.font('Helvetica').fontSize(8);
    }

    doc.rect(PAGE_MARGIN, y, CONTENT_W, rowH).stroke('#cbd5e1');

    const cells = [
      String(it.line_no),
      it.description,
      it.hsn_sac || '-',
      qty(it.quantity),
      it.unit || '-',
      money(it.rate),
      `${Number(it.gst_rate)}%`,
      money(it.amount),
    ];
    cells.forEach((text, i) => {
      doc.text(text, colX(i) + 3, y + 4, { width: COLS[i].w - 6, align: COLS[i].align });
    });

    y += rowH;
  }

  return y + 8;
}

function drawGstSummary(doc: PDFKit.PDFDocument, inv: PdfInvoice, startY: number, isIntra: boolean): number {
  let y = startY;
  doc.font('Helvetica-Bold').fontSize(9).text('GST Summary', PAGE_MARGIN, y);
  y = doc.y + 4;

  const cols = isIntra
    ? ['GST %', 'Taxable', 'CGST', 'SGST', 'Total Tax']
    : ['GST %', 'Taxable', 'IGST', 'Total Tax'];
  const w = (CONTENT_W * 0.6) / cols.length;

  doc.rect(PAGE_MARGIN, y, w * cols.length, 16).fillAndStroke('#f1f5f9', '#94a3b8');
  doc.fillColor('#000').font('Helvetica-Bold').fontSize(8);
  cols.forEach((c, i) => doc.text(c, PAGE_MARGIN + w * i + 3, y + 4, { width: w - 6, align: i === 0 ? 'left' : 'right' }));
  y += 16;

  doc.font('Helvetica').fontSize(8);
  for (const b of inv.breakup || []) {
    const vals = isIntra
      ? [`${Number(b.gst_rate)}%`, money(b.taxable_amount), money(b.cgst_amount), money(b.sgst_amount), money(b.cgst_amount + b.sgst_amount)]
      : [`${Number(b.gst_rate)}%`, money(b.taxable_amount), money(b.igst_amount), money(b.igst_amount)];
    doc.rect(PAGE_MARGIN, y, w * cols.length, 14).stroke('#cbd5e1');
    vals.forEach((v, i) => doc.text(v, PAGE_MARGIN + w * i + 3, y + 3, { width: w - 6, align: i === 0 ? 'left' : 'right' }));
    y += 14;
  }

  return y + 10;
}
