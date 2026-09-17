/**
 * Money handling for EGP.
 *
 * Prices are stored as numeric(12,2) in Postgres. JavaScript floats cannot
 * represent 0.1 exactly, so every arithmetic step here rounds to piastres
 * (2 decimal places) before moving on. Summing a basket of floats without
 * rounding is how receipts end up one piastre off the card terminal.
 */

/**
 * Round to piastres (2 decimal places).
 *
 * The obvious `Math.round(value * 100) / 100` is wrong on exactly the values
 * that matter: `1.005 * 100` is `100.49999999999999` in binary floating point,
 * so it rounds a price of 1.005 down to 1.00. Adding Number.EPSILON, which is
 * the usual suggested fix, does not help either - EPSILON is about 2.2e-16 and
 * the error here is a thousand times larger.
 *
 * Shifting the decimal point through the number's string form avoids the
 * multiplication entirely: `Number("1.005e2")` is exactly 100.5, which rounds
 * up as a person would expect.
 */
export function toPiastres(value: number): number {
  if (!Number.isFinite(value)) return 0;

  const text = String(value);
  // Very large or very small magnitudes already render in exponential form,
  // where appending another exponent would not parse. Money never reaches
  // those, but falling back keeps the function total.
  if (text.includes('e') || text.includes('E')) {
    return Math.round(value * 100) / 100;
  }

  const shifted = Math.round(Number(`${text}e2`));
  return Number(`${shifted}e-2`);
}

export function multiplyMoney(unitPrice: number, quantity: number): number {
  return toPiastres(unitPrice * quantity);
}

export function sumMoney(values: readonly number[]): number {
  return toPiastres(values.reduce((total, value) => toPiastres(total + value), 0));
}

export interface BasketLine {
  quantity: number;
  unit_price_egp: number;
  discount_egp?: number;
}

export interface BasketTotals {
  subtotal_egp: number;
  discount_egp: number;
  total_egp: number;
}

/**
 * The single place basket arithmetic happens. The sale screen shows this, the
 * receipt prints this, and create_store_sale() recomputes the same numbers in
 * SQL - the client's totals are never trusted as input.
 */
export function calculateBasket(
  lines: readonly BasketLine[],
  orderDiscountEgp = 0,
): BasketTotals {
  const lineTotals = lines.map((line) =>
    toPiastres(multiplyMoney(line.unit_price_egp, line.quantity) - (line.discount_egp ?? 0)),
  );
  const subtotal = sumMoney(lineTotals);
  const discount = toPiastres(orderDiscountEgp);
  const total = toPiastres(Math.max(0, subtotal - discount));
  return { subtotal_egp: subtotal, discount_egp: discount, total_egp: total };
}

// Intl.NumberFormat is expensive to construct, and the sale screen formats a
// price for every row on every keystroke, so the two we need are built once.
const EGP_FORMATTERS = new Map<string, Intl.NumberFormat>();

/**
 * Format for display.
 *
 * Both locales use Latin digits deliberately. `ar-EG` would otherwise render
 * Eastern Arabic numerals, and staff read these numbers off the screen while
 * comparing them against the card terminal and the printed receipt, which show
 * Latin digits.
 */
export function formatEGP(value: number, locale: 'ar' | 'en' = 'en'): string {
  const key = locale === 'ar' ? 'ar-EG' : 'en-EG';

  let formatter = EGP_FORMATTERS.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(`${key}-u-nu-latn`, {
      style: 'currency',
      currency: 'EGP',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    EGP_FORMATTERS.set(key, formatter);
  }

  return formatter.format(value);
}
