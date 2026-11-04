import { describe, expect, it } from 'vitest';
import { cairoDate, cairoStartOfDayISO } from '../packages/shared/src/datetime';

describe('cairoStartOfDayISO', () => {
  it('is 22:00Z the evening before in winter (UTC+2)', () => {
    expect(cairoStartOfDayISO('2026-01-15')).toBe('2026-01-14T22:00:00.000Z');
  });

  it('is 21:00Z the evening before under summer time (UTC+3)', () => {
    expect(cairoStartOfDayISO('2026-07-15')).toBe('2026-07-14T21:00:00.000Z');
  });

  it('round-trips: the instant reads as that day in Cairo', () => {
    for (const day of ['2026-01-01', '2026-04-30', '2026-05-01', '2026-10-29', '2026-10-30', '2026-12-31']) {
      expect(cairoDate(new Date(cairoStartOfDayISO(day)))).toBe(day);
    }
  });

  it('defaults to today in Cairo', () => {
    expect(cairoStartOfDayISO()).toBe(cairoStartOfDayISO(cairoDate()));
  });
});
