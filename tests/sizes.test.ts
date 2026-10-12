import { describe, expect, it } from 'vitest';
import { compareVariants, sizeRank } from '../packages/shared/src/sizes';

describe('sizes', () => {
  it('puts letter sizes in garment order, not alphabetical', () => {
    const sizes = ['XXL', 'L', 'XL', 'M', 'S', '3XL', 'XS'];
    expect([...sizes].sort((a, b) => sizeRank(a) - sizeRank(b))).toEqual(['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL']);
  });

  it('treats XXXL and 2XL as the same run', () => {
    expect(sizeRank('XXXL')).toBe(sizeRank('3XL'));
    expect(sizeRank('2xl')).toBe(sizeRank('XXL'));
  });

  it('sorts shoe sizes numerically', () => {
    const sizes = ['45', '39', '41', '40', '44'];
    expect([...sizes].sort((a, b) => sizeRank(a) - sizeRank(b))).toEqual(['39', '40', '41', '44', '45']);
  });

  it('groups by colour, then size within it', () => {
    const variants = [
      { size: '42', color: 'Black', sku: 'HSL-42-BLK' },
      { size: '41', color: 'Taupe', sku: 'HSL-41-TUP' },
      { size: '41', color: 'Black', sku: 'HSL-41-BLK' },
    ];
    expect([...variants].sort(compareVariants).map((v) => v.sku)).toEqual(['HSL-41-BLK', 'HSL-42-BLK', 'HSL-41-TUP']);
  });

  it('puts a variant with no size last', () => {
    expect(sizeRank(null)).toBeGreaterThan(sizeRank('3XL'));
    expect(sizeRank('One size')).toBeGreaterThan(sizeRank('46'));
  });
});
