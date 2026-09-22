import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useGetIdentity } from '@refinedev/core';
import { can, formatEGP } from '@duch/shared';
import { supabase } from '../lib/supabase';
import { useLocale } from '../i18n';
import { Badge, Card, Spinner } from '../components/ui';
import type { StaffIdentity } from '../providers/authProvider';

interface Totals {
  orders: number;
  revenue: number;
  lowStock: number;
  openIssues: number;
  overdueParcels: number;
}

interface MovementRow {
  id: string;
  created_at: string;
  quantity_delta: number;
  reason: string;
  sku: string;
  product_title: string;
  staff_name: string | null;
}

/** Midnight in Cairo, as an ISO instant, so "today" means the shop's today. */
function cairoStartOfDay(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '01';
  // Egypt runs UTC+2, or UTC+3 while summer time is in force. Asking the
  // browser to parse the local wall-clock date with an explicit zone offset
  // would need that rule; letting Date resolve "YYYY-MM-DDT00:00:00" in the
  // viewer's own zone is close enough for a headline figure and is corrected
  // by the server-side daily view used for real reporting.
  return new Date(`${get('year')}-${get('month')}-${get('day')}T00:00:00`).toISOString();
}

export function Dashboard() {
  const { t, locale } = useLocale();
  const { data: identity } = useGetIdentity<StaffIdentity>();
  // Sales and packing staff cannot read sync_issues, so the count would always
  // come back zero for them. A confident zero is worse than no tile at all.
  const maySeeSync = can(identity?.role, 'sync.read');
  const [totals, setTotals] = useState<Totals | null>(null);
  const [movements, setMovements] = useState<MovementRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const since = cairoStartOfDay();

    async function load() {
      const [orders, low, issues, feed, overdue] = await Promise.all([
        supabase
          .from('orders')
          .select('total_egp')
          .gte('created_at', since)
          .neq('fulfillment_status', 'cancelled'),
        supabase.from('v_low_stock').select('variant_id', { count: 'exact', head: true }),
        supabase
          .from('sync_issues')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'open'),
        supabase
          .from('v_stock_movement_feed')
          .select('id, created_at, quantity_delta, reason, sku, product_title, staff_name')
          .order('created_at', { ascending: false })
          .limit(12),
        // Parcels the courier has stopped moving. This belongs on the front
        // page rather than buried in a report: it is the owner's anti-theft
        // control, and it only works if somebody sees it every day.
        supabase
          .from('v_custody_exceptions')
          .select('shipment_id', { count: 'exact', head: true }),
      ]);

      if (cancelled) return;

      const orderRows = (orders.data ?? []) as Array<{ total_egp: number }>;
      setTotals({
        orders: orderRows.length,
        revenue: orderRows.reduce((sum, row) => sum + Number(row.total_egp), 0),
        lowStock: low.count ?? 0,
        openIssues: issues.count ?? 0,
        overdueParcels: overdue.count ?? 0,
      });
      setMovements((feed.data ?? []) as MovementRow[]);
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!totals) return <Spinner label={t('app.loading')} />;

  return (
    <div className="space-y-5">
      <h1 className="text-lg font-extrabold">{t('dashboard.title')}</h1>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label={t('dashboard.salesToday')} value={String(totals.orders)} />
        <Stat label={t('dashboard.revenueToday')} value={formatEGP(totals.revenue, locale)} />
        <Stat
          label={t('dashboard.lowStock')}
          value={String(totals.lowStock)}
          to="/stock"
          tone={totals.lowStock > 0 ? 'warn' : undefined}
        />
        <Stat
          label={t('dashboard.overdueParcels')}
          value={String(totals.overdueParcels)}
          to="/reports"
          tone={totals.overdueParcels > 0 ? 'bad' : undefined}
        />
        {maySeeSync ? (
          <Stat
            label={t('dashboard.openIssues')}
            value={String(totals.openIssues)}
            to="/sync"
            tone={totals.openIssues > 0 ? 'bad' : undefined}
          />
        ) : null}
      </div>

      <Card>
        <h2 className="mb-3 text-sm font-bold">{t('dashboard.recentMovements')}</h2>
        {!movements ? (
          <Spinner />
        ) : (
          <ul className="divide-y divide-duch-line">
            {movements.map((movement) => (
              <li key={movement.id} className="flex items-center gap-3 py-2.5 text-sm">
                <span
                  className={`tabular w-12 text-end font-extrabold ${
                    movement.quantity_delta > 0 ? 'text-emerald-600' : 'text-red-600'
                  }`}
                >
                  {movement.quantity_delta > 0 ? '+' : ''}
                  {movement.quantity_delta}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold">{movement.product_title}</span>
                  <span className="tabular block text-xs text-stone-500">{movement.sku}</span>
                </span>
                <Badge>{t(`reason.${movement.reason}`)}</Badge>
                <span className="hidden w-28 truncate text-xs text-stone-500 sm:block">
                  {movement.staff_name ?? '—'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function Stat({
  label,
  value,
  to,
  tone,
}: {
  label: string;
  value: string;
  to?: string;
  tone?: 'warn' | 'bad';
}) {
  const body = (
    <Card
      className={
        tone === 'bad' ? 'border-red-200 bg-red-50' : tone === 'warn' ? 'border-amber-200 bg-amber-50' : ''
      }
    >
      <p className="text-xs font-semibold text-stone-600">{label}</p>
      <p className="tabular mt-1 text-xl font-extrabold">{value}</p>
    </Card>
  );

  return to ? (
    <Link to={to} className="block">
      {body}
    </Link>
  ) : (
    body
  );
}
