import { useMemo } from 'react';
import { completedSales, type Range } from '../../lib/reportMath';
import { giftFund, profitReport, type GiftFund, type ProfitReport } from '../../lib/profitMath';
import { dayBefore, useCourierCosts, useProfitBooks, useSalesRows, type ProfitBooks, type SalesRows } from './data';

export interface ProfitModel {
  range: Range;
  books: ProfitBooks;
  rows: SalesRows;
  /** The range's sales as the owner counts them: complete, still to come, came back. */
  done: ReturnType<typeof completedSales>;
  report: ProfitReport;
  fund: GiftFund;
}

/**
 * Everything the profit screens show for a range, worked out once: the
 * completed sales, the statement, and the gift fund with what it carried in.
 */
export function useProfitModel(range: Range) {
  const books = useProfitBooks(true);
  // The gift fund rolls over, so the sales are read from the day it started
  // when that is before the range.
  const fundFrom = books.data?.settings.gift_fund_from ?? null;
  const since = !fundFrom ? null : fundFrom < range.from ? fundFrom : range.from;
  const rows = useSalesRows(since);
  const courier = useCourierCosts(range, true);

  const model = useMemo<ProfitModel | null>(() => {
    if (!books.data || !rows.data || !courier.data || !fundFrom || !since) return null;
    // Rows read for an earlier range are still good for a later one; rows
    // for a later one do not cover this range yet.
    if (rows.data.since > since) return null;
    const { sheets, ads, expenses, giftPieces, settings } = books.data;
    const done = completedSales(rows.data.lines, rows.data.returns, rows.data.orders, range);
    const report = profitReport({ range, sold: done.sold, sheets, ads, expenses, giftPieces, courier: courier.data, giftFrom: fundFrom });

    let collectedBefore = 0;
    if (fundFrom < range.from) {
      const before = { from: fundFrom, to: dayBefore(range.from) };
      const earlier = completedSales(rows.data.lines, rows.data.returns, rows.data.orders, before);
      collectedBefore = profitReport({
        range: before,
        sold: earlier.sold,
        sheets,
        ads: [],
        expenses: [],
        giftPieces: [],
        courier: [],
        giftFrom: fundFrom,
      }).giftReserve;
    }
    const fund = giftFund({
      range,
      from: fundFrom,
      openingEgp: settings.gift_fund_opening_egp,
      collected: report.giftReserve,
      collectedBefore,
      expenses,
    });
    return { range, books: books.data, rows: rows.data, done, report, fund };
  }, [books.data, rows.data, courier.data, fundFrom, since, range]);

  return {
    model,
    loading: books.loading || rows.loading || courier.loading,
    error: books.error ?? rows.error ?? courier.error,
    /** After something was typed in: costs, ads, expenses. */
    reloadBooks: books.reload,
  };
}
