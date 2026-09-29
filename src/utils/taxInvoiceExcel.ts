/**
 * Excel (.xlsx) renderer for the standalone Tax Invoice module.
 *
 * Produces a genuine xlsx workbook (not CSV with a renamed extension), so the
 * numbers arrive as numbers and stay usable in Excel formulas.
 */

import ExcelJS from 'exceljs';
import { INVOICE_SUPPLIER, INVOICE_BANK, numberToWordsINR } from './invoiceConstants';
import type { PdfInvoice } from './taxInvoicePdf';

const MONEY_FMT = '#,##0.00';
const THIN = { style: 'thin' as const, color: { argb: 'FFCBD5E1' } };
const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };

/** "2026-09-29" -> "29-09-2026", parsed textually so no timezone can shift it. */
const dateStr = (value: any): string => {
  const s = String(value ?? '');
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;

  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
};

export async function renderInvoiceExcel(inv: PdfInvoice): Promise<Buffer> {
  const party = inv.party_snapshot || {};
  const isIntra = inv.gst_mode === 'cgst_sgst';

  const wb = new ExcelJS.Workbook();
  wb.creator = INVOICE_SUPPLIER.name;
  wb.created = new Date();

  const ws = wb.addWorksheet('Tax Invoice', {
    pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  ws.columns = [
    { width: 6 },   // A  #
    { width: 42 },  // B  Description
    { width: 12 },  // C  HSN/SAC
    { width: 10 },  // D  Qty
    { width: 8 },   // E  Unit
    { width: 14 },  // F  Rate
    { width: 8 },   // G  GST%
    { width: 16 },  // H  Amount
  ];

  let r = 1;

  const titleRow = (text: string, size: number, bold = true) => {
    ws.mergeCells(r, 1, r, 8);
    const c = ws.getCell(r, 1);
    c.value = text;
    c.font = { bold, size };
    c.alignment = { horizontal: 'center' };
    r++;
  };

  const leftRow = (text: string, bold = false, size = 10) => {
    ws.mergeCells(r, 1, r, 8);
    const c = ws.getCell(r, 1);
    c.value = text;
    c.font = { bold, size };
    r++;
  };

  // ─── Title + supplier ──────────────────────────────────────────────────────
  titleRow('TAX INVOICE', 16);
  if (inv.is_cancelled) {
    ws.mergeCells(r, 1, r, 8);
    const c = ws.getCell(r, 1);
    c.value = '** CANCELLED **';
    c.font = { bold: true, size: 11, color: { argb: 'FFB91C1C' } };
    c.alignment = { horizontal: 'center' };
    r++;
  }
  r++;

  leftRow(INVOICE_SUPPLIER.name, true, 12);
  for (const line of INVOICE_SUPPLIER.addressLines) leftRow(line);
  leftRow(`GSTIN: ${INVOICE_SUPPLIER.gstin}`);
  leftRow(`Mobile: ${INVOICE_SUPPLIER.mobile}    Email: ${INVOICE_SUPPLIER.email}`);
  r++;

  // ─── Bill to (cols A-D) + meta (cols F-H) ──────────────────────────────────
  const blockStart = r;

  const partyLines = [
    party.name || '-',
    party.address1,
    party.address2,
    [party.city, party.state, party.pincode].filter(Boolean).join(', '),
    party.gstin ? `GSTIN: ${party.gstin}` : '',
    party.email ? `Email: ${party.email}` : '',
    party.phone ? `Phone: ${party.phone}` : '',
  ].filter((l: any) => l && String(l).trim());

  ws.getCell(blockStart, 1).value = 'BILL TO';
  ws.getCell(blockStart, 1).font = { bold: true, size: 10 };
  partyLines.forEach((line: any, i: number) => {
    const row = blockStart + 1 + i;
    ws.mergeCells(row, 1, row, 4);
    const c = ws.getCell(row, 1);
    c.value = String(line);
    if (i === 0) c.font = { bold: true };
  });

  const meta: Array<[string, string]> = [
    ['Invoice No:', inv.invoice_no],
    ['Invoice Date:', dateStr(inv.invoice_date)],
  ];
  if (inv.place_of_supply) meta.push(['Place of Supply:', String(inv.place_of_supply)]);
  meta.push(['Tax Type:', isIntra ? 'CGST + SGST' : 'IGST']);

  meta.forEach(([label, value], i) => {
    const row = blockStart + i;
    ws.mergeCells(row, 6, row, 7);
    ws.getCell(row, 6).value = label;
    ws.getCell(row, 6).font = { bold: true };
    ws.getCell(row, 8).value = value;
  });

  r = blockStart + Math.max(partyLines.length + 1, meta.length) + 1;

  // ─── Items ─────────────────────────────────────────────────────────────────
  const headers = ['#', 'Description', 'HSN/SAC', 'Qty', 'Unit', 'Rate', 'GST%', 'Amount'];
  const headerRow = ws.getRow(r);
  headers.forEach((h, i) => {
    const c = headerRow.getCell(i + 1);
    c.value = h;
    c.font = { bold: true, size: 10 };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
    c.border = BORDER;
    c.alignment = { horizontal: i === 1 ? 'left' : 'center', vertical: 'middle' };
  });
  headerRow.commit();
  r++;

  for (const it of inv.items) {
    const row = ws.getRow(r);
    row.getCell(1).value = it.line_no;
    row.getCell(2).value = it.description;
    row.getCell(3).value = it.hsn_sac || '';
    row.getCell(4).value = Number(it.quantity);
    row.getCell(5).value = it.unit || '';
    row.getCell(6).value = Number(it.rate);
    row.getCell(7).value = Number(it.gst_rate) / 100;
    row.getCell(8).value = Number(it.amount);

    row.getCell(2).alignment = { wrapText: true, vertical: 'top' };
    row.getCell(4).numFmt = '#,##0.###';
    row.getCell(6).numFmt = MONEY_FMT;
    row.getCell(7).numFmt = '0.00%';
    row.getCell(8).numFmt = MONEY_FMT;
    for (let c = 1; c <= 8; c++) row.getCell(c).border = BORDER;

    row.commit();
    r++;
  }

  r++;

  // ─── Totals (labels in F:G, values in H) ───────────────────────────────────
  const totalRow = (label: string, value: number, bold = false) => {
    ws.mergeCells(r, 6, r, 7);
    const l = ws.getCell(r, 6);
    l.value = label;
    l.font = { bold };
    l.alignment = { horizontal: 'right' };

    const v = ws.getCell(r, 8);
    v.value = value;
    v.numFmt = MONEY_FMT;
    v.font = { bold };
    if (bold) {
      l.border = { top: THIN };
      v.border = { top: THIN };
    }
    r++;
  };

  totalRow('Subtotal', Number(inv.subtotal));
  if (Number(inv.discount) > 0) totalRow('Discount', -Number(inv.discount));
  totalRow('Taxable Value', Number(inv.taxable_amount));
  if (isIntra) {
    totalRow('CGST', Number(inv.cgst_amount));
    totalRow('SGST', Number(inv.sgst_amount));
  } else {
    totalRow('IGST', Number(inv.igst_amount));
  }
  if (Number(inv.round_off) !== 0) totalRow('Round Off', Number(inv.round_off));
  totalRow('TOTAL (INR)', Number(inv.total_amount), true);

  r++;
  leftRow(`Amount in words: ${numberToWordsINR(inv.total_amount)} RUPEES ONLY`, true);
  r++;

  // ─── GST slab summary ──────────────────────────────────────────────────────
  if (inv.breakup && inv.breakup.length > 1) {
    leftRow('GST Summary', true);
    const cols = isIntra ? ['GST %', 'Taxable', 'CGST', 'SGST'] : ['GST %', 'Taxable', 'IGST'];
    const hr = ws.getRow(r);
    cols.forEach((c, i) => {
      const cell = hr.getCell(i + 1);
      cell.value = c;
      cell.font = { bold: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
      cell.border = BORDER;
    });
    hr.commit();
    r++;

    for (const b of inv.breakup) {
      const row = ws.getRow(r);
      const vals = isIntra
        ? [Number(b.gst_rate) / 100, Number(b.taxable_amount), Number(b.cgst_amount), Number(b.sgst_amount)]
        : [Number(b.gst_rate) / 100, Number(b.taxable_amount), Number(b.igst_amount)];
      vals.forEach((v, i) => {
        const cell = row.getCell(i + 1);
        cell.value = v;
        cell.numFmt = i === 0 ? '0.00%' : MONEY_FMT;
        cell.border = BORDER;
      });
      row.commit();
      r++;
    }
    r++;
  }

  // ─── Bank + footer ─────────────────────────────────────────────────────────
  leftRow('Bank Details', true);
  leftRow(`Account Holder: ${INVOICE_BANK.accountName}`);
  leftRow(`Account No: ${INVOICE_BANK.accountNo}`);
  leftRow(`IFSC: ${INVOICE_BANK.ifsc}`);
  leftRow(`Branch: ${INVOICE_BANK.branch}`);
  leftRow(`Account Type: ${INVOICE_BANK.accountType}`);
  r++;

  if (inv.notes && String(inv.notes).trim()) {
    leftRow(`Notes: ${String(inv.notes)}`);
    r++;
  }

  leftRow(`For ${INVOICE_SUPPLIER.name}`, true);
  leftRow('Authorised Signatory');

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}
