/* Temporary self-test for the tax invoice module. Deleted after running. */
import fs from 'fs';
import path from 'path';
import { computeTaxInvoice, resolveGstMode, formatInvoiceNo, financialYear, round2 } from './utils/taxInvoiceCalc';
import { renderInvoicePdf } from './utils/taxInvoicePdf';
import { renderInvoiceExcel } from './utils/taxInvoiceExcel';

let failures = 0;
function check(label: string, actual: any, expected: any) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failures++; console.log(`  FAIL ${label}\n       got      ${JSON.stringify(actual)}\n       expected ${JSON.stringify(expected)}`); }
  else console.log(`  ok   ${label} = ${JSON.stringify(actual)}`);
}

console.log('\n--- GST mode (supplier is 06 / Haryana) ---');
check('Haryana party -> intra', resolveGstMode('06'), 'cgst_sgst');
check('Maharashtra party -> inter', resolveGstMode('27'), 'igst');
check('no state code -> inter (safe default)', resolveGstMode(''), 'igst');
check('null state code -> inter', resolveGstMode(null), 'igst');

console.log('\n--- Simple single-slab IGST ---');
const a = computeTaxInvoice(
  [{ description: 'Air manifest filing', quantity: 10, rate: 150, gst_rate: 18 }], 0, 'igst');
check('subtotal', a.subtotal, 1500);
check('taxable', a.taxable_amount, 1500);
check('igst', a.igst_amount, 270);
check('cgst', a.cgst_amount, 0);
check('total', a.total_amount, 1770);
check('round_off', a.round_off, 0);

console.log('\n--- Intra-state splits CGST/SGST ---');
const b = computeTaxInvoice(
  [{ description: 'Service', quantity: 1, rate: 1000, gst_rate: 18 }], 0, 'cgst_sgst');
check('cgst', b.cgst_amount, 90);
check('sgst', b.sgst_amount, 90);
check('igst is zero', b.igst_amount, 0);
check('cgst+sgst == total tax', round2(b.cgst_amount + b.sgst_amount), b.total_tax);
check('total', b.total_amount, 1180);

console.log('\n--- Odd tax that must split without losing a paisa ---');
const c = computeTaxInvoice(
  [{ description: 'Odd', quantity: 1, rate: 100.05, gst_rate: 5 }], 0, 'cgst_sgst');
check('cgst+sgst == total tax', round2(c.cgst_amount + c.sgst_amount), c.total_tax);

console.log('\n--- Multi-slab with invoice-level discount ---');
const d = computeTaxInvoice([
  { description: 'A', quantity: 2, rate: 500, gst_rate: 18 },
  { description: 'B', quantity: 1, rate: 500, gst_rate: 5 },
], 150, 'igst');
check('subtotal', d.subtotal, 1500);
check('taxable after discount', d.taxable_amount, 1350);
check('slab count', d.breakup.length, 2);
check('apportioned taxable sums to invoice taxable',
  round2(d.breakup.reduce((s, x) => s + x.taxable_amount, 0)), d.taxable_amount);
check('tax sums to igst total',
  round2(d.breakup.reduce((s, x) => s + x.igst_amount, 0)), d.igst_amount);
check('total balances',
  d.total_amount, Math.round(round2(d.taxable_amount + d.total_tax)));

console.log('\n--- Rounding to nearest rupee ---');
const e = computeTaxInvoice([{ description: 'R', quantity: 1, rate: 100.40, gst_rate: 0 }], 0, 'igst');
check('100.40 -> 100', e.total_amount, 100);
check('round_off', e.round_off, -0.4);
const f = computeTaxInvoice([{ description: 'R', quantity: 1, rate: 100.60, gst_rate: 0 }], 0, 'igst');
check('100.60 -> 101', f.total_amount, 101);
check('round_off', f.round_off, 0.4);

console.log('\n--- Validation rejects bad input ---');
const rejects: Array<[string, () => void]> = [
  ['empty items', () => computeTaxInvoice([], 0, 'igst')],
  ['zero quantity', () => computeTaxInvoice([{ description: 'x', quantity: 0, rate: 1, gst_rate: 18 }], 0, 'igst')],
  ['negative rate', () => computeTaxInvoice([{ description: 'x', quantity: 1, rate: -5, gst_rate: 18 }], 0, 'igst')],
  ['blank description', () => computeTaxInvoice([{ description: '  ', quantity: 1, rate: 1, gst_rate: 18 }], 0, 'igst')],
  ['gst over 100', () => computeTaxInvoice([{ description: 'x', quantity: 1, rate: 1, gst_rate: 120 }], 0, 'igst')],
  ['NaN quantity', () => computeTaxInvoice([{ description: 'x', quantity: 'abc', rate: 1, gst_rate: 18 }], 0, 'igst')],
  ['discount > subtotal', () => computeTaxInvoice([{ description: 'x', quantity: 1, rate: 100, gst_rate: 18 }], 500, 'igst')],
  ['negative discount', () => computeTaxInvoice([{ description: 'x', quantity: 1, rate: 100, gst_rate: 18 }], -5, 'igst')],
];
for (const [label, fn] of rejects) {
  try { fn(); failures++; console.log(`  FAIL ${label} — should have thrown but did not`); }
  catch { console.log(`  ok   ${label} rejected`); }
}

console.log('\n--- Invoice numbering ---');
check('FY in September', financialYear(new Date('2026-09-29')), '2026-27');
check('FY in February', financialYear(new Date('2027-02-10')), '2026-27');
check('FY on 1 April', financialYear(new Date('2027-04-01')), '2027-28');
check('formatted', formatInvoiceNo(42, new Date('2026-09-29')), 'EMS/2026-27/00042');

// ─── Renderers ───────────────────────────────────────────────────────────────
(async () => {
  const sample = {
    invoice_no: 'EMS/2026-27/00042',
    invoice_date: '2026-09-29',
    place_of_supply: 'Maharashtra',
    gst_mode: 'igst' as const,
    party_snapshot: {
      name: 'NAVI MUMBAI LOGISTICS PVT LTD', gstin: '27AABCU9603R1ZX',
      address1: 'Plot 14, Sector 19', address2: 'Vashi',
      city: 'Navi Mumbai', state: 'Maharashtra', pincode: '400705',
      email: 'ops@nmlogistics.in', phone: '022-27812345',
    },
    items: d.items.map(x => ({ ...x })),
    breakup: d.breakup,
    subtotal: d.subtotal, discount: d.discount, taxable_amount: d.taxable_amount,
    cgst_amount: d.cgst_amount, sgst_amount: d.sgst_amount, igst_amount: d.igst_amount,
    round_off: d.round_off, total_amount: d.total_amount,
    notes: 'Payable within 15 days.',
  };

  const outDir = process.env.SELFTEST_OUT || '.';
  console.log('\n--- Renderers ---');

  const pdf = await renderInvoicePdf(sample);
  const pdfOk = pdf.length > 800 && pdf.subarray(0, 5).toString() === '%PDF-';
  console.log(`  ${pdfOk ? 'ok  ' : 'FAIL'} PDF produced ${pdf.length} bytes, header ${JSON.stringify(pdf.subarray(0, 5).toString())}`);
  if (!pdfOk) failures++;
  fs.writeFileSync(path.join(outDir, 'selftest-invoice.pdf'), pdf);

  const xlsx = await renderInvoiceExcel(sample);
  // xlsx is a zip -> must start with "PK"
  const xlsxOk = xlsx.length > 800 && xlsx.subarray(0, 2).toString() === 'PK';
  console.log(`  ${xlsxOk ? 'ok  ' : 'FAIL'} XLSX produced ${xlsx.length} bytes, header ${JSON.stringify(xlsx.subarray(0, 2).toString())}`);
  if (!xlsxOk) failures++;
  fs.writeFileSync(path.join(outDir, 'selftest-invoice.xlsx'), xlsx);

  // Multi-page stress: 60 lines must not throw or truncate
  const many = computeTaxInvoice(
    Array.from({ length: 60 }, (_, i) => ({
      description: `Line item ${i + 1} with a deliberately long description to force text wrapping inside the table cell`,
      quantity: i + 1, rate: 123.45, gst_rate: i % 2 ? 18 : 5,
    })), 0, 'cgst_sgst');
  // `many` was computed with cgst_sgst, so it carries the right gst_mode itself.
  const bigPdf = await renderInvoicePdf({ ...sample, ...many } as any);
  console.log(`  ${bigPdf.length > 3000 ? 'ok  ' : 'FAIL'} 60-line PDF produced ${bigPdf.length} bytes`);
  if (bigPdf.length <= 3000) failures++;

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('RENDER ERROR:', e); process.exit(1); });
