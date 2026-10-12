/**
 * Which of a variant's Shopify options is its size, and which its colour.
 *
 * Shopify lets each product name its options freely, and Duch's do: "Size"
 * on clothes, "Shoe Size" and "Shoe size" on the slippers, "Color" on both.
 * Matching on an exact name missed every slipper, so their sizes were never
 * stored. A name that contains the word is enough.
 */

const SIZE_WORDS = ['size', 'مقاس'];
const COLOR_WORDS = ['color', 'colour', 'لون'];

function pick(options: Record<string, string>, words: string[]): string | null {
  for (const [name, value] of Object.entries(options)) {
    const key = name.toLowerCase();
    if (words.some((word) => key.includes(word)) && value) return value;
  }
  return null;
}

export function sizeOf(options: Record<string, string>): string | null {
  return pick(options, SIZE_WORDS);
}

export function colorOf(options: Record<string, string>): string | null {
  return pick(options, COLOR_WORDS);
}

/**
 * A REST webhook payload names its options on the product and gives each
 * variant option1..option3 by position; this puts them back together as
 * { "Shoe Size": "41", "Color": "Black" }, the same shape the import stores.
 */
export function optionsFromRest(
  productOptions: unknown,
  variant: Record<string, unknown>,
): Record<string, string> {
  const result: Record<string, string> = {};
  if (!Array.isArray(productOptions)) return result;
  for (const option of productOptions as Array<{ name?: string; position?: number }>) {
    const position = Number(option.position);
    const value = variant[`option${position}`];
    if (option.name && typeof value === 'string' && value) result[option.name] = value;
  }
  return result;
}
