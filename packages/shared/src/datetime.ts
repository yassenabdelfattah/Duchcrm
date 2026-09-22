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

// ar-EG's medium date style is numeric (23/09/2026) rather than spelled out,
// and Intl embeds LRM/RLM marks around the numbers to keep them ordered
// inside Arabic text. Those marks survive being wrapped in <bdi> - the
// isolation the rest of the app relies on - because they are inside the
// string itself, not the surrounding markup. Left in, a browser lays the day
// out after the year: 23/09/2026 renders as 232026/09/. Stripped here once,
// every caller gets a date nobody has to read twice, matching this module's
// own promise of Latin digits in a fixed order regardless of language.
const DIRECTION_MARKS = /[‎‏]/g;

export function formatDateTime(value: string | Date, locale: 'ar' | 'en' = 'en'): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '';
  return formatter(locale, { dateStyle: 'medium', timeStyle: 'short' }, 'datetime')
    .format(date)
    .replace(DIRECTION_MARKS, '');
}

export function formatDate(value: string | Date, locale: 'ar' | 'en' = 'en'): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '';
  return formatter(locale, { dateStyle: 'medium' }, 'date')
    .format(date)
    .replace(DIRECTION_MARKS, '');
}

/**
 * Today in Cairo, as `YYYY-MM-DD`.
 *
 * Not `new Date().toISOString().slice(0, 10)`, which is the UTC date. Egypt
 * runs summer time, so between roughly 9pm and midnight Cairo the UTC date is
 * still yesterday - and a report defaulting to "today" would silently open on
 * the wrong day every evening, which is when the shop is busiest.
 *
 * `en-CA` is used because it formats as YYYY-MM-DD, which is what a date
 * input expects.
 */
export function cairoDate(value: string | Date = new Date()): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: CAIRO,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** `cairoDate` shifted by whole days. Negative goes back. */
export function cairoDatePlusDays(days: number, from: Date = new Date()): string {
  return cairoDate(new Date(from.getTime() + days * 86_400_000));
}
