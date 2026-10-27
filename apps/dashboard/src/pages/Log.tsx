import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ReceiptText } from 'lucide-react';
import { formatDay, formatTime } from '@duch/shared';
import { supabase } from '../lib/supabase';
import { arabicError } from '../lib/errors';
import { LOG_FILTERS, logNote, logTitle, type LogFilter, type LogRow } from '../lib/logText';
import { useLocale } from '../i18n';
import { Button, Card, EmptyState, ErrorNote, Input, Spinner, cx } from '../components/ui';

/**
 * Everything that happened, newest first: every piece that came in or went
 * out of stock and every change to an order - when, who did it, and where the
 * piece went or why.
 *
 * It used to be a tab of the last 300 rows in Reports, a stock row naming the
 * reason and nothing else. Now each line says which order, which customer, or
 * who has the piece, and the whole history is there, fifty at a time. A link
 * here with ?q= opens it already searched - one product, one order.
 */

const PAGE = 50;

export function Log() {
  const { t, locale } = useLocale();
  const [params] = useSearchParams();

  const [search, setSearch] = useState(() => params.get('q') ?? '');
  const [filter, setFilter] = useState<LogFilter>('all');
  const [rows, setRows] = useState<LogRow[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const term = search.trim().replace(/[%,()*]/g, '');

  const fetchPage = useCallback(
    async (offset: number) => {
      const definition: { kind?: 'stock' | 'order'; actions?: readonly string[] } = LOG_FILTERS[filter];
      let query = supabase
        .from('v_log')
        .select('*', { count: offset === 0 ? 'exact' : undefined })
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(offset, offset + PAGE - 1);
      if (definition.kind) query = query.eq('kind', definition.kind);
      if (definition.actions) query = query.in('action', [...definition.actions]);
      if (term) query = query.ilike('search_text', `%${term}%`);
      return query;
    },
    [filter, term],
  );

  // A new search or filter starts again from the newest.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      setRows(null);
      const { data, count, error: queryError } = await fetchPage(0);
      if (cancelled) return;
      if (queryError) {
        setError(arabicError(queryError));
        setRows([]);
        return;
      }
      setError(null);
      const list = (data ?? []) as LogRow[];
      setRows(list);
      setTotal(count ?? null);
      setHasMore(list.length === PAGE);
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [fetchPage]);

  async function loadMore() {
    if (!rows) return;
    setLoadingMore(true);
    const { data, error: queryError } = await fetchPage(rows.length);
    setLoadingMore(false);
    if (queryError) {
      setError(arabicError(queryError));
      return;
    }
    const list = (data ?? []) as LogRow[];
    setRows([...rows, ...list]);
    setHasMore(list.length === PAGE);
  }

  // Under one heading per day, the way the log is read: "what happened on
  // Tuesday".
  const days = useMemo(() => {
    const groups: Array<{ day: string; rows: LogRow[] }> = [];
    for (const row of rows ?? []) {
      const last = groups[groups.length - 1];
      if (last && last.day === row.activity_date) last.rows.push(row);
      else groups.push({ day: row.activity_date, rows: [row] });
    }
    return groups;
  }, [rows]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-extrabold">{t('log.title')}</h1>
        <p className="mt-1 text-xs text-stone-500">{t('log.help')}</p>
      </div>

      <div className="space-y-2">
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t('log.search')}
          inputMode="search"
          autoComplete="off"
        />
        <div className="flex flex-wrap gap-2">
          {(Object.keys(LOG_FILTERS) as LogFilter[]).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setFilter(value)}
              className={cx(
                'min-h-9 rounded-full px-3 text-xs font-semibold transition-colors',
                filter === value
                  ? 'bg-duch-ink text-white'
                  : 'border border-duch-line bg-white text-stone-600 hover:bg-stone-50',
              )}
            >
              {t(`log.filter.${value}`)}
            </button>
          ))}
        </div>
      </div>

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      {!rows ? (
        <Spinner label={t('app.loading')} />
      ) : rows.length === 0 ? (
        <EmptyState title={t('log.empty')} />
      ) : (
        <>
          {total !== null ? (
            <p className="tabular text-xs text-stone-500">{t('log.count', { count: total })}</p>
          ) : null}

          {days.map((group) => (
            <section key={group.day} className="space-y-2">
              <h2 className="sticky top-0 z-10 bg-duch-paper/95 py-1 text-xs font-bold text-stone-500 backdrop-blur">
                {formatDay(group.day, locale)}
              </h2>
              <Card className="divide-y divide-duch-line p-0">
                {group.rows.map((row) => (
                  <LogLine key={`${row.kind}:${row.id}`} row={row} onSearch={setSearch} />
                ))}
              </Card>
            </section>
          ))}

          {hasMore ? (
            <div className="flex justify-center">
              <Button variant="secondary" onClick={() => void loadMore()} disabled={loadingMore}>
                {loadingMore ? t('app.loading') : t('log.more')}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function LogLine({ row, onSearch }: { row: LogRow; onSearch: (value: string) => void }) {
  const { t, locale } = useLocale();
  const note = logNote(row, t);
  const delta = row.quantity_delta;

  return (
    <div className="flex items-start gap-3 px-4 py-3">
      {/* The change in stock where there is one. A change to an order moves no
          stock - its pieces are the separate line beside it - so it gets an
          icon rather than anything that reads as a quantity of nought. */}
      {delta === null ? (
        <span className="mt-0.5 inline-flex min-w-11 shrink-0 justify-center rounded-lg bg-stone-100 px-2 py-1.5 text-stone-500">
          <ReceiptText className="h-4 w-4" aria-hidden />
        </span>
      ) : (
        <span
          className={cx(
            'tabular mt-0.5 inline-flex min-w-11 shrink-0 justify-center rounded-lg px-2 py-1 text-sm font-extrabold',
            delta < 0 ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700',
          )}
          dir="ltr"
        >
          {delta > 0 ? `+${delta}` : delta}
        </span>
      )}

      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-sm font-semibold">{logTitle(row, t)}</p>

        {/* Separate pieces rather than one run of text: product names and
            codes are English inside an Arabic line, and joined with dots
            the browser reorders them into nonsense. */}
        {row.kind === 'stock' && row.product_title ? (
          <p className="flex flex-wrap items-baseline gap-x-2 text-xs text-stone-600">
            <bdi className="font-semibold">{row.product_title}</bdi>
            {row.variant_label ? <bdi>{row.variant_label}</bdi> : null}
            {row.sku ? (
              // The whole history of this piece, one tap away.
              <button
                type="button"
                onClick={() => onSearch(row.sku ?? '')}
                className="tabular text-stone-500 underline decoration-stone-300 underline-offset-2"
                dir="ltr"
              >
                {row.sku}
              </button>
            ) : null}
          </p>
        ) : null}

        {/* Where it went, or why. */}
        {row.order_number ? (
          <p className="flex flex-wrap items-baseline gap-x-2 text-xs text-stone-600">
            <Link
              to={`/orders?q=${encodeURIComponent(row.order_number)}`}
              className="tabular font-semibold text-duch-ink underline decoration-stone-300 underline-offset-2"
              dir="ltr"
            >
              {row.order_number}
            </Link>
            {row.customer_name ? <bdi>{row.customer_name}</bdi> : null}
          </p>
        ) : row.taken_by ? (
          <p className="text-xs text-stone-600">{t('log.with', { name: row.taken_by })}</p>
        ) : null}

        {note ? (
          <p className="text-xs text-stone-500">
            <bdi>{note}</bdi>
          </p>
        ) : null}
      </div>

      <div className="shrink-0 text-end text-xs text-stone-500">
        <p className="tabular">{formatTime(row.created_at, locale)}</p>
        {/* Blank means the system did it - Shopify, a nightly job - not a person. */}
        <p>
          <bdi>{row.staff_name ?? t('log.system')}</bdi>
        </p>
      </div>
    </div>
  );
}
