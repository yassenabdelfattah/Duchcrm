import { describe, expect, it } from 'vitest';
import { compareRuns, previousRun, runCost, type ProductionRun } from '../apps/dashboard/src/lib/productionMath';

const run = (fields: Partial<ProductionRun>): ProductionRun => ({
  id: 'r',
  made_on: '2026-11-01',
  name: 'Cuffed sweatpants',
  note: null,
  products: [
    { product_id: 'black', pieces: 80, applied_sheet_id: null },
    { product_id: 'grey', pieces: 70, applied_sheet_id: null },
  ],
  lines: [
    { label: 'قماش', basis: 'total', amount_egp: 45000 },
    { label: 'تفصيل', basis: 'per_piece', amount_egp: 120 },
    { label: 'تغليف', basis: 'total', amount_egp: 3750 },
  ],
  receipts: [],
  ...fields,
});

describe('runCost', () => {
  it('shares a total bill over every piece of the run and leaves a per-piece amount as typed', () => {
    const cost = runCost(run({}));
    expect(cost.pieces).toBe(150);
    expect(cost.lines.map((line) => line.perPiece)).toEqual([300, 120, 25]);
    expect(cost.perPiece).toBe(445);
    // 45,000 + 120 x 150 + 3,750
    expect(cost.total).toBe(66750);
  });

  it('rounds a share to the piastre', () => {
    const cost = runCost(run({ products: [{ product_id: 'black', pieces: 3, applied_sheet_id: null }], lines: [{ label: 'قماش', basis: 'total', amount_egp: 100 }] }));
    expect(cost.lines[0]!.perPiece).toBe(33.33);
    expect(cost.total).toBe(100);
  });

  it('cannot share a total over no pieces, but still knows what was paid', () => {
    const cost = runCost(run({ products: [{ product_id: 'black', pieces: 0, applied_sheet_id: null }] }));
    expect(cost.lines.map((line) => line.perPiece)).toEqual([null, 120, null]);
    expect(cost.perPiece).toBeNull();
    expect(cost.total).toBe(48750);
  });

  it('needs no pieces when every line is per piece', () => {
    const cost = runCost(run({ products: [{ product_id: 'black', pieces: 0, applied_sheet_id: null }], lines: [{ label: 'قماش', basis: 'per_piece', amount_egp: 300 }] }));
    expect(cost.perPiece).toBe(300);
    expect(cost.total).toBe(0);
  });
});

describe('previousRun', () => {
  const august = run({ id: 'aug', made_on: '2026-08-10' });
  const october = run({ id: 'oct', made_on: '2026-10-05', products: [{ product_id: 'black', pieces: 50, applied_sheet_id: null }] });
  const hoodies = run({ id: 'hood', made_on: '2026-10-20', products: [{ product_id: 'hoodie', pieces: 40, applied_sheet_id: null }] });
  const november = run({ id: 'nov', made_on: '2026-11-01' });
  const all = [november, hoodies, october, august];

  it('is the latest earlier run that made one of the same products', () => {
    expect(previousRun(all, november)!.id).toBe('oct');
    expect(previousRun(all, october)!.id).toBe('aug');
    expect(previousRun(all, august)).toBeNull();
    expect(previousRun(all, hoodies)).toBeNull();
  });

  it('can be asked about one product of the run', () => {
    // Grey was last made in August; black in October.
    expect(previousRun(all, november, 'grey')!.id).toBe('aug');
    expect(previousRun(all, november, 'black')!.id).toBe('oct');
  });
});

describe('compareRuns', () => {
  it('says what moved per piece, line by line, by name', () => {
    const before = runCost(
      run({
        lines: [
          { label: 'قماش', basis: 'per_piece', amount_egp: 280 },
          { label: 'تفصيل', basis: 'per_piece', amount_egp: 120 },
          { label: 'طباعة', basis: 'per_piece', amount_egp: 30 },
        ],
      }),
    );
    const result = compareRuns(runCost(run({})), before);
    expect(result.lines).toEqual([
      { label: 'قماش', before: 280, now: 300, change: 20 },
      { label: 'تفصيل', before: 120, now: 120, change: 0 },
      // New this time, and gone this time: shown, with nothing to subtract.
      { label: 'تغليف', before: null, now: 25, change: null },
      { label: 'طباعة', before: 30, now: null, change: null },
    ]);
    // 445 now, 430 then.
    expect(result.change).toBe(15);
  });
});
