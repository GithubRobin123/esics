/**
 * Fixed billing-entity details for auto-generated Air invoices.
 * These never change per-customer — only the buyer (customer profile) side does.
 */

export const INVOICE_SUPPLIER = {
  name: 'EDI Software Solutions',
  addressLines: ['House No 44', 'Lohina Palwal 121106'],
  mobile: '9813603030',
  gstin: '06ASLPJ8726H1ZF',
  email: 'bills@ediss.in',
};

export const INVOICE_BANK = {
  accountName: 'EDI SOFTWARE SOLUTIONS',
  accountNo: '50200082782142',
  ifsc: 'HDFC0001734',
  branch: 'Hodal',
};

export const INVOICE_SAC_CODE = '998439';

const ONES = ['', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE',
  'TEN', 'ELEVEN', 'TWELVE', 'THIRTEEN', 'FOURTEEN', 'FIFTEEN', 'SIXTEEN', 'SEVENTEEN', 'EIGHTEEN', 'NINETEEN'];
const TENS = ['', '', 'TWENTY', 'THIRTY', 'FORTY', 'FIFTY', 'SIXTY', 'SEVENTY', 'EIGHTY', 'NINETY'];

function threeDigitsToWords(n: number): string {
  let str = '';
  if (n >= 100) {
    str += `${ONES[Math.floor(n / 100)]} HUNDRED `;
    n %= 100;
  }
  if (n >= 20) {
    str += `${TENS[Math.floor(n / 10)]} `;
    n %= 10;
  }
  if (n > 0) {
    str += `${ONES[n]} `;
  }
  return str.trim();
}

/** Converts a rupee amount (whole number) into Indian-numbering words, e.g. 2124 -> "TWO THOUSAND ONE HUNDRED AND TWENTY-FOUR" */
export function numberToWordsINR(amount: number): string {
  const n = Math.round(amount);
  if (n === 0) return 'ZERO';

  const crore = Math.floor(n / 10000000);
  const lakh = Math.floor((n % 10000000) / 100000);
  const thousand = Math.floor((n % 100000) / 1000);
  const hundred = n % 1000;

  const parts: string[] = [];
  if (crore) parts.push(`${threeDigitsToWords(crore)} CRORE`);
  if (lakh) parts.push(`${threeDigitsToWords(lakh)} LAKH`);
  if (thousand) parts.push(`${threeDigitsToWords(thousand)} THOUSAND`);
  if (hundred) {
    if (hundred < 100 && parts.length > 0) parts.push(`AND ${threeDigitsToWords(hundred)}`);
    else parts.push(threeDigitsToWords(hundred));
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}
