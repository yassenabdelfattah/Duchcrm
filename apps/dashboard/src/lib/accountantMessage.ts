/**
 * The message that goes to the accountant with a statement.
 *
 * What he writes into his ledger: each product, how many, what they came to,
 * a rule under each, and their total. Then what was taken off - each charge,
 * their total - and what is left, which is the transfer (the owner,
 * 2026-10-26).
 *
 * It has to add up on paper: products less deductions is the transfer. Where
 * the two would not meet - an order discount, a parcel collected for a little
 * more or less than its goods - the gap is written as its own line rather
 * than left for him to find.
 */

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
}

/** Money without the currency and the .00: easier to read in a chat message. */
const PLAIN_NUMBER = new Intl.NumberFormat('en-EG', { maximumFractionDigits: 2 });
const RULE = '--------------------';

const cents = (value: number) => Math.round(value * 100) / 100;

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

  // What the courier took off: a return's fee, the shipping on a parcel paid
  // online, a charge on the whole statement. A credit on the statement is a
  // deduction with a minus.
  const charges: { label: string; amount: number }[] = [];
  for (const line of lines) {
    const parcel = line.order_number ?? line.tracking_number ?? '';
    if (line.outcome === 'adjustment') {
      charges.push({
        label: line.note ?? t('settlementOutcome.adjustment'),
        amount: Number(line.fee_egp) - Number(line.collected_egp),
      });
    } else if (Number(line.fee_egp) > 0) {
      const what = line.outcome === 'delivered' ? t('settlements.shippingOf') : t(`settlementOutcome.${line.outcome}`);
      charges.push({ label: `${what} ${parcel}`.trim(), amount: Number(line.fee_egp) });
    }
  }

  out.push(`${t('settlements.productsTotal')} = ${n(listed)}`);
  out.push(RULE);

  if (goods !== undefined) {
    const discounts = cents(productsTotal - Number(goods));
    if (discounts !== 0) charges.push({ label: t('settlements.customerDiscounts'), amount: discounts });
  }

  // Whatever is left between the lines and the transfer: a parcel collected
  // for a little more or less than its goods.
  const net = lines.reduce((sum, line) => sum + Number(line.net_egp), 0);
  const gap = cents(listed - charges.reduce((sum, charge) => sum + charge.amount, 0) - net);
  if (gap !== 0) charges.push({ label: t('settlements.collectionDifference'), amount: gap });

  if (charges.length > 0) {
    out.push(t('settlements.debits'));
    for (const charge of charges) out.push(`${charge.label} = ${n(charge.amount)}`);
    out.push(RULE);
    out.push(`${t('settlements.totalDebits')} = ${n(charges.reduce((sum, charge) => sum + charge.amount, 0))}`);
    out.push(RULE);
  }

  out.push(`${t('settlements.netLine')} = ${n(net)}`);
  return out.join('\n');
}
