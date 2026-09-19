/**
 * Dates and times, always in Cairo and always in Latin digits.
 *
 * `ar-EG` renders numbers in Eastern Arabic numerals, which would put ١٩/٠٩
 * next to a price showing 1,450.00 on the same receipt. Staff read these
 * against the courier's system and the card terminal, both of which use Latin
 * digits, so the whole interface uses one numeral system regardless of
 * language. The `-u-nu-latn` extension keeps the Arabic month names and word
 * order while fixing the digits.
 */

const CAIRO = 'Africa/Cairo';

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatter(locale: 'ar' | 'en', options: Intl.DateTimeFormatOptions, key: string) {
  const cacheKey = `${locale}:${key}`;
  let cached = FORMATTERS.get(cacheKey);
  if (!cached) {
    const base = locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB';
    cached = new Intl.DateTimeFormat(base, { timeZone: CAIRO, ...options });
    FORMATTERS.set(cacheKey, cached);
  }
  return cached;
}

export function formatDateTime(value: string | Date, locale: 'ar' | 'en' = 'en'): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '';
  return formatter(locale, { dateStyle: 'medium', timeStyle: 'short' }, 'datetime').format(date);
}

export function formatDate(value: string | Date, locale: 'ar' | 'en' = 'en'): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '';
  return formatter(locale, { dateStyle: 'medium' }, 'date').format(date);
}
