/**
 * Sizes in the order a person expects, smallest first.
 *
 * Sorting by SKU put sizes in alphabetical order - L, M, XL, XXL - which
 * nobody reads a size run in. Letter sizes follow the garment run, numbers
 * (the slippers' 39-46) go up numerically, and anything else keeps its name
 * order after them. In the right-to-left interface the smallest therefore
 * sits on the right, where the eye starts.
 */

const LETTER_RUN = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL', '5XL'];

/** A sortable rank: letter sizes first in garment order, then numbers, then the rest. */
export function sizeRank(size: string | null | undefined): number {
  if (!size) return 10_000;
  const normalised = size.trim().toUpperCase().replace(/\s+/g, '').replace(/^XXXL$/, '3XL').replace(/^2XL$/, 'XXL');
  const letter = LETTER_RUN.indexOf(normalised);
  if (letter >= 0) return letter;
  const number = Number.parseFloat(normalised);
  if (Number.isFinite(number)) return 100 + number;
  return 5_000;
}

interface Sizable {
  size: string | null;
  color?: string | null;
  sku?: string;
}

/**
 * Orders variants of one product: by colour, then by size within it, then
 * by SKU so the order is always the same.
 */
export function compareVariants(a: Sizable, b: Sizable): number {
  const color = (a.color ?? '').localeCompare(b.color ?? '');
  if (color !== 0) return color;
  const rank = sizeRank(a.size) - sizeRank(b.size);
  if (rank !== 0) return rank;
  const name = (a.size ?? '').localeCompare(b.size ?? '');
  if (name !== 0) return name;
  return (a.sku ?? '').localeCompare(b.sku ?? '');
}
