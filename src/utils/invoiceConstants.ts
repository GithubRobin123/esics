/**
 * Fixed billing-entity details for auto-generated Air invoices.
 * These never change per-customer — only the buyer (customer profile) side does.
 */


// Building No./Flat No.: PLOT NO-3512 
// Road/Street: MAHARANA PRATAP COLONY,
//  AGWANPUR Nearby Landmark: NEAR MILAN RESTAURANT 
// City/Town/Village: Palwal District: Palwal
//  State: Haryana PIN Code: 121102

export const INVOICE_SUPPLIER = {
  name: 'EDI Manifest Solutions',
  addressLines: ['PLOT NO-3512', 'MAHARANA PRATAP COLONY', 'Palwal 121102'],
  mobile: '8882741223',
  gstin: '06CVRPD3667A1ZN',
  email: 'bills@ediss.in',
};

export const INVOICE_BANK = {
  accountName: 'EDI MANIFEST SOLUTIONS',
  accountNo: '50200083752941',
  ifsc: 'HDFC0000459',
  branch: 'PALWAL - HARYANA',
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
