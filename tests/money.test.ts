import { describe, expect, it } from 'vitest';
import {
  calculateBasket,
  calculateInvoiceTotals,
  multiplyMoney,
  sumMoney,
  toPiastres,
} from '../packages/shared/src/money';
import { normalizeEgyptianPhone } from '../packages/shared/src/schemas';
import { cairoDate, cairoDatePlusDays } from '../packages/shared/src/datetime';

/**
 * Basket arithmetic. The database recomputes all of this before it writes an
 * order, but the cashier reads these numbers out loud to the customer, so they
 * have to agree with what the database is about to store to the piastre.
 */

describe('toPiastres', () => {
  it('rounds to two decimal places', () => {
    expect(toPiastres(1450.004)).toBe(1450);
    expect(toPiastres(1450.006)).toBe(1450.01);
  });

  it('rounds a halfway value up, which naive multiplication gets wrong', () => {
    // Math.round(1.005 * 100) / 100 gives 1, because 1.005 * 100 is
    // 100.49999999999999 in binary floating point.
    expect(toPiastres(1.005)).toBe(1.01);
    expect(toPiastres(1450.005)).toBe(1450.01);
  });

  it('survives values that float arithmetic gets wrong', () => {
    // 0.1 + 0.2 is 0.30000000000000004 in binary floating point.
    expect(toPiastres(0.1 + 0.2)).toBe(0.3);
  });
});

describe('sumMoney', () => {
  it('adds a long list without accumulating drift', () => {
    const tenPiastres = Array.from({ length: 100 }, () => 0.1);
    expect(sumMoney(tenPiastres)).toBe(10);
  });

  it('returns zero for an empty basket', () => {
    expect(sumMoney([])).toBe(0);
  });
});

describe('multiplyMoney', () => {
  it('multiplies a price by a quantity', () => {
    expect(multiplyMoney(1450, 3)).toBe(4350);
  });

  it('keeps a two-decimal price exact across a quantity', () => {
    // Prices are numeric(12,2) in the database, so a unit price never has more
    // than two decimals. 1450.55 * 3 is 4351.6499999999996 as a raw float.
    expect(multiplyMoney(1450.55, 3)).toBe(4351.65);
    expect(multiplyMoney(0.07, 3)).toBe(0.21);
  });
});

describe('calculateBasket', () => {
  it('totals a simple basket', () => {
    expect(
      calculateBasket([
        { quantity: 2, unit_price_egp: 1450 },
        { quantity: 1, unit_price_egp: 1850 },
      ]),
    ).toEqual({ subtotal_egp: 4750, discount_egp: 0, total_egp: 4750 });
  });

  it('applies a per-line discount before the order discount', () => {
    expect(
      calculateBasket([{ quantity: 2, unit_price_egp: 1000, discount_egp: 150 }], 100),
    ).toEqual({ subtotal_egp: 1850, discount_egp: 100, total_egp: 1750 });
  });

  it('never returns a negative total, however large the discount', () => {
    const totals = calculateBasket([{ quantity: 1, unit_price_egp: 500 }], 900);
    expect(totals.total_egp).toBe(0);
  });

  it('handles an empty basket', () => {
    expect(calculateBasket([])).toEqual({ subtotal_egp: 0, discount_egp: 0, total_egp: 0 });
  });
});

describe('normalizeEgyptianPhone', () => {
  it.each([
    ['01012345678', '01012345678'],
    ['+20 100 123 4567', '01001234567'],
    ['0020 111 234 5678', '01112345678'],
    ['20 122 345 6789', '01223456789'],
    ['010-1234-5678', '01012345678'],
    ['1012345678', '01012345678'],
  ])('normalises %s to %s', (input, expected) => {
    expect(normalizeEgyptianPhone(input)).toBe(expected);
  });

  it.each([
    ['01312345678'], // 013 is not a valid Egyptian mobile prefix
    ['0101234567'], // one digit short
    ['not a phone'],
    [''],
  ])('rejects %s', (input) => {
    expect(normalizeEgyptianPhone(input)).toBeNull();
  });

  it('gives the same answer for the same person entered three different ways', () => {
    const forms = ['01001234567', '+201001234567', '00201001234567'];
    const normalised = new Set(forms.map(normalizeEgyptianPhone));
    expect(normalised.size).toBe(1);
  });
});

describe('calculateInvoiceTotals', () => {
  // A real seeded online order: 3,300 of goods, 70 shipping.
  const shipped = {
    subtotal_egp: 3300,
    discount_egp: 0,
    shipping_egp: 70,
    total_egp: 3300,
  };

  it('adds shipping on top of the goods total', () => {
    expect(calculateInvoiceTotals(shipped).payable_egp).toBe(3370);
  });

  it('does not mistake the goods total for the amount due', () => {
    // The whole reason this function exists: orders.total_egp excludes
    // shipping, so printing it as the amount due short-changes every shipped
    // order by the delivery fee.
    const totals = calculateInvoiceTotals(shipped);
    expect(totals.payable_egp).not.toBe(totals.total_egp);
    expect(totals.payable_egp - totals.total_egp).toBe(70);
  });

  it('leaves a store sale with no shipping untouched', () => {
    const totals = calculateInvoiceTotals({
      subtotal_egp: 1000,
      discount_egp: 0,
      shipping_egp: 0,
      total_egp: 1000,
    });
    expect(totals.payable_egp).toBe(1000);
  });

  it('shows a discount without letting it touch the shipping fee', () => {
    // Discount is already reflected in total_egp by the time it is stored.
    const totals = calculateInvoiceTotals({
      subtotal_egp: 3300,
      discount_egp: 300,
      shipping_egp: 70,
      total_egp: 3000,
    });
    expect(totals.discount_egp).toBe(300);
    expect(totals.payable_egp).toBe(3070);
  });

  it('keeps piastres exact where floating point would drift', () => {
    const totals = calculateInvoiceTotals({
      subtotal_egp: 1450.1,
      discount_egp: 0,
      shipping_egp: 70.2,
      total_egp: 1450.1,
    });
    expect(totals.payable_egp).toBe(1520.3);
  });
});

describe('cairoDate', () => {
  // Egypt observes summer time, so Cairo runs 2 or 3 hours ahead of UTC
  // depending on the month. A report that defaults to "today" using the UTC
  // date opens on the wrong day every evening.
  it('returns the Cairo date, not the UTC one, late in the evening', () => {
    // 22:30 in Cairo during summer time is 19:30 UTC the same day.
    expect(cairoDate(new Date('2026-09-21T19:30:00Z'))).toBe('2026-09-21');
  });

  it('is still the Cairo day after UTC has rolled over', () => {
    // 01:30 UTC on the 22nd is 04:30 on the 22nd in Cairo - same day here.
    expect(cairoDate(new Date('2026-09-22T01:30:00Z'))).toBe('2026-09-22');
  });

  it('puts late Cairo evening on the Cairo day, where UTC would still say yesterday', () => {
    // 23:30 Cairo on 21 September is 20:30 UTC on 21 September in summer, but
    // in winter (UTC+2) 23:30 Cairo on 1 January is 21:30 UTC the same day.
    expect(cairoDate(new Date('2026-01-01T21:30:00Z'))).toBe('2026-01-01');
  });

  it('counts back whole days from today', () => {
    const from = new Date('2026-09-21T12:00:00Z');
    expect(cairoDatePlusDays(-7, from)).toBe('2026-09-14');
    expect(cairoDatePlusDays(0, from)).toBe('2026-09-21');
  });
});
