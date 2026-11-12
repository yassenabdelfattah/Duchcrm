/**
 * The manufacturing log's sums (2026-11-12).
 *
 * A run is the products made together and what making them cost. A line is
 * either what was paid in total - shared over every piece the run made - or
 * an amount per piece. From those: what one piece cost, what the run cost
 * altogether, and how that compares with the run before it.
 *
 * The database works a line out the same way (v_production_run_lines), and
 * that is what gets written when a run is made a product's cost.
 */

import { toPiastres } from '@duch/shared';

export interface RunLine {
  label: string;
  basis: 'total' | 'per_piece';
  amount_egp: number;
}

export interface RunProduct {
  product_id: string;
  pieces: number;
  /** The cost sheet the run was applied to this product as, once it was. */
  applied_sheet_id: string | null;
}

export interface ProductionRun {
  id: string;
  made_on: string;
  name: string;
  note: string | null;
  products: RunProduct[];
  lines: RunLine[];
  receipts: Array<{ id: string; path: string; file_name: string | null }>;
}

export interface RunCost {
  pieces: number;
  /** Each line as it comes to for one piece; null when a total has no pieces to be shared over. */
  lines: Array<{ label: string; basis: RunLine['basis']; amount: number; perPiece: number | null }>;
  /** One piece, every line added up; null when a line could not be worked out. */
  perPiece: number | null;
  /** Everything the run cost: the totals as paid, the per-piece amounts times the pieces. */
  total: number;
}

export function runCost(run: Pick<ProductionRun, 'products' | 'lines'>): RunCost {
  const pieces = run.products.reduce((total, product) => total + Math.max(0, Number(product.pieces) || 0), 0);
  const lines = run.lines.map((line) => {
    const amount = Number(line.amount_egp);
    const perPiece = line.basis === 'per_piece' ? toPiastres(amount) : pieces > 0 ? toPiastres(amount / pieces) : null;
    return { label: line.label, basis: line.basis, amount, perPiece };
  });
  const known = lines.every((line) => line.perPiece !== null);
  return {
    pieces,
    lines,
    perPiece: known ? toPiastres(lines.reduce((total, line) => total + (line.perPiece ?? 0), 0)) : null,
    total: toPiastres(lines.reduce((total, line) => total + (line.basis === 'total' ? line.amount : line.amount * pieces), 0)),
  };
}

/** The run before this one that made the same product: the latest earlier one. */
export function previousRun(runs: ProductionRun[], run: ProductionRun, productId?: string): ProductionRun | null {
  const ids = new Set(productId ? [productId] : run.products.map((product) => product.product_id));
  const earlier = runs
    .filter((other) => other.id !== run.id && other.made_on <= run.made_on && other.products.some((product) => ids.has(product.product_id)))
    // The same day twice: the one that is not this run still counts as before it.
    .sort((a, b) => b.made_on.localeCompare(a.made_on));
  return earlier[0] ?? null;
}

export interface LineChange {
  label: string;
  before: number | null;
  now: number | null;
  /** Now less before, per piece; null when the line is only in one of the two. */
  change: number | null;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * One piece now against one piece then, line by line by name: what went up,
 * what went down, what is new and what is gone.
 */
export function compareRuns(now: RunCost, before: RunCost): { lines: LineChange[]; change: number | null } {
  const lines: LineChange[] = now.lines.map((line) => {
    const old = before.lines.find((other) => same(other.label, line.label));
    return {
      label: line.label,
      before: old?.perPiece ?? null,
      now: line.perPiece,
      change: old && old.perPiece !== null && line.perPiece !== null ? toPiastres(line.perPiece - old.perPiece) : null,
    };
  });
  for (const old of before.lines) {
    if (!now.lines.some((line) => same(line.label, old.label))) lines.push({ label: old.label, before: old.perPiece, now: null, change: null });
  }
  return {
    lines,
    change: now.perPiece !== null && before.perPiece !== null ? toPiastres(now.perPiece - before.perPiece) : null,
  };
}
