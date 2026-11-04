/**
 * The message that goes to the accountant with a statement.
 *
 * What he writes into his ledger: each product, how many, what they came to,
 * a rule under each, and their total. Then anything added on top, and what
 * was taken off - each charge, their total - and what is left, which is the
 * transfer (the owner, 2026-10-26).
 *
 * It has to add up on paper: products plus additions less deductions is the
 * transfer. Where
 * the two would not meet - an order discount, Accurate charging more or less
 * for shipping than the customer paid, a parcel collected for a little more
 * or less than it should have been - the gap is written as its own line
 * rather than left for him to find.
 */

import { toPiastres } from '@duch/shared';

export interface MessageProduct {
  title: string;
  quantity: number;
  total_egp: number;
}

export interface MessageLine {
  outcome: string;
  tracking_number: string | null;
  order_number: string | null;
  collected_egp: number;
  fee_egp: number;
  net_egp: number;
  note: string | null;
  /** Shipping the customer paid at the door, inside what was collected; null on older lines. */
  customer_shipping_egp?: number | null;
  /** On an exchange's replacement: what the piece sent back paid of it. */
  exchange_credit_egp?: number | null;
}

/** Money without the currency and the .00: easier to read in a chat message. */
const PLAIN_NUMBER = new Intl.NumberFormat('en-EG', { maximumFractionDigits: 2 });
const RULE = '--------------------';

// The shared rounding, under the name this file always used.
const cents = toPiastres;

/**
 * `goods` is what the delivered orders came to after their own discounts
 * (v_settlement_breakdown.goods_egp): the products less it is what customers
 * were let off, which is otherwise indistinguishable from a short collection.
 */
export function accountantMessage(
  products: MessageProduct[],
  lines: MessageLine[],
  t: (key: string) => string,
  goods?: number,
): string {
  const n = (value: number) => PLAIN_NUMBER.format(cents(value));
  const out: string[] = [];
  let listed = 0;

  // One line per product, whatever prices it sold at.
  const byProduct = new Map<string, { quantity: number; total: number }>();
  for (const p of products) {
    const row = byProduct.get(p.title) ?? { quantity: 0, total: 0 };
    row.quantity += Number(p.quantity);
    row.total += Number(p.total_egp);
    byProduct.set(p.title, row);
  }
  for (const [title, row] of byProduct) {
    out.push(`${title} * ${row.quantity} = ${n(row.total)}`);
    out.push(RULE);
    listed += row.total;
  }
  const productsTotal = listed;

  // Money in for a code the CRM does not know: there is no product to name.
  for (const line of lines) {
    if (line.outcome === 'delivered' && !line.order_number && Number(line.collected_egp) > 0) {
      out.push(`${line.tracking_number ?? '—'} = ${n(Number(line.collected_egp))}`);
      out.push(RULE);
      listed += Number(line.collected_egp);
    }
  }

  // What the courier took off, as totals - the accountant needs no order
  // numbers (the owner, 2026-11-04): the fees on everything that came back,
  // as one shipping loss; the shipping on parcels the customer did not pay
  // shipping for at the door; and each charge on the whole statement, by its
  // note. A credit on the statement is one of these with a minus.
  //
  // Not the shipping on a delivery the customer paid shipping for at the
  // door: that was collected with the goods and charged straight back, and
  // all it leaves is whatever Accurate charged above or below it - one line
  // for the whole statement.
  let returnFees = 0;
  let shippingFees = 0;
  let shippingDifference = 0;
  const statementCharges: { label: string; amount: number }[] = [];
  for (const line of lines) {
    if (line.outcome === 'adjustment') {
      statementCharges.push({
        label: line.note ?? t('settlementOutcome.adjustment'),
        amount: Number(line.fee_egp) - Number(line.collected_egp),
      });
    } else if (line.outcome === 'delivered' && Number(line.customer_shipping_egp) > 0) {
      shippingDifference += Number(line.fee_egp) - Number(line.customer_shipping_egp);
    } else if (line.outcome === 'delivered') {
      shippingFees += Number(line.fee_egp);
    } else {
      returnFees += Number(line.fee_egp);
    }
  }

  // An exchange's replacement is listed at its price, and the piece the
  // customer sent back paid part of it. Its own line, so it does not read as a
  // discount anyone was given - CSHP--030330's 550 was #1407's hoodie.
  let exchangeCredits = 0;
  for (const line of lines) {
    const credit = Number(line.exchange_credit_egp ?? 0);
    if (line.outcome === 'delivered' && Number(line.collected_egp) > 0 && credit > 0) exchangeCredits += credit;
  }

  const charges = [
    { label: t('settlements.shippingLosses'), amount: cents(returnFees) },
    { label: t('settlements.shippingFees'), amount: cents(shippingFees) },
    ...statementCharges,
    { label: t('settlements.shippingGain'), amount: cents(shippingDifference) },
    { label: t('settlements.exchangeOf'), amount: cents(exchangeCredits) },
  ].filter((charge) => charge.amount !== 0);

  out.push(`${t('settlements.productsTotal')} = ${n(listed)}`);
  out.push(RULE);

  if (goods !== undefined) {
    const discounts = cents(productsTotal - Number(goods) - exchangeCredits);
    if (discounts !== 0) charges.push({ label: t('settlements.customerDiscounts'), amount: discounts });
  }

  // Whatever is left between the lines and the transfer: a parcel collected
  // for a little more or less than it should have been.
  const net = lines.reduce((sum, line) => sum + Number(line.net_egp), 0);
  const gap = cents(listed - charges.reduce((sum, charge) => sum + charge.amount, 0) - net);
  if (gap !== 0) charges.push({ label: t('settlements.collectionDifference'), amount: gap });

  // What came in on top - a credit on the statement, customers paying more
  // shipping than Accurate charged, a parcel collected for a little more - is
  // an addition in its own block, not a deduction with a minus: "زيادة شحن =
  // -10" under خصومات read as wrong (the owner, 2026-11-04).
  const additions = charges.filter((charge) => charge.amount < 0).map((charge) => ({ ...charge, amount: -charge.amount }));
  const deductions = charges.filter((charge) => charge.amount >= 0);

  for (const [block, heading, totalLabel] of [
    [additions, 'settlements.additions', 'settlements.totalAdditions'],
    [deductions, 'settlements.debits', 'settlements.totalDebits'],
  ] as const) {
    if (block.length === 0) continue;
    out.push(t(heading));
    for (const charge of block) out.push(`${charge.label} = ${n(charge.amount)}`);
    out.push(RULE);
    out.push(`${t(totalLabel)} = ${n(block.reduce((sum, charge) => sum + charge.amount, 0))}`);
    out.push(RULE);
  }

  out.push(`${t('settlements.netLine')} = ${n(net)}`);
  return out.join('\n');
}
