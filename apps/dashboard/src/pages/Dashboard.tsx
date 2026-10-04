import { useEffect, useState, type ComponentType } from 'react';
import { Link } from 'react-router';
import { useGetIdentity } from '@refinedev/core';
import {
  Banknote,
  Boxes,
  ChevronLeft,
  CircleCheck,
  HandCoins,
  PackageCheck,
  PackageOpen,
  RefreshCw,
  Truck,
} from 'lucide-react';
import { can, canAny, formatEGP } from '@duch/shared';
import { supabase } from '../lib/supabase';
import { useLocale } from '../i18n';
import { readSeenAt } from '../hooks/useQueueAlert';
import { Badge, Card, Code, Spinner, cx, type StatusTone } from '../components/ui';
import type { StaffIdentity } from '../providers/authProvider';

/**
 * The home screen: what needs doing now, for whoever opened it.
 *
 * The owner's ask (2026-10-04): a home screen that is a to-do list rather
 * than totals. Each card counts something that is waiting on someone and
 * opens the list already filtered to it. A person sees only the cards their
 * role can act on - a confident zero from a table they cannot read would be
 * worse than no card. Today's takings and the latest stock movements follow.
 */

/** Late with the courier: the same line as the tracker on the Orders screen. */
const COURIER_LATE_DAYS = 7;

const TO_SHIP = ['awaiting_confirmation', 'confirmed', 'ready_to_pack', 'packed', 'awaiting_pickup'];

interface Todo {
  key: string;
  icon: ComponentType<{ className?: string }>;
  count: number;
  label: string;
  detail: string | null;
  to: string;
  tone: StatusTone;
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
  // Egypt runs UTC+2, or UTC+3 while summer time is in force. Letting Date
  // resolve "YYYY-MM-DDT00:00:00" in the viewer's own zone is close enough
  // for a headline figure; real reporting uses the server-side daily view.
  return new Date(`${get('year')}-${get('month')}-${get('day')}T00:00:00`).toISOString();
}

const TONE_STYLES: Record<StatusTone, { card: string; icon: string }> = {
  wait: { card: 'border-amber-200 bg-amber-50', icon: 'bg-amber-100 text-amber-800' },
  road: { card: 'border-blue-200 bg-blue-50', icon: 'bg-blue-100 text-blue-700' },
  done: { card: 'border-emerald-200 bg-emerald-50', icon: 'bg-emerald-100 text-emerald-700' },
  back: { card: 'border-red-200 bg-red-50', icon: 'bg-red-100 text-red-700' },
  closed: { card: 'border-duch-line bg-white', icon: 'bg-stone-100 text-stone-600' },
};

export function Dashboard() {
  const { t, locale } = useLocale();
  const { data: identity } = useGetIdentity<StaffIdentity>();
  const perms = identity?.permissions;

  const [todos, setTodos] = useState<Todo[] | null>(null);
  const [today, setToday] = useState<{ sales: number; revenue: number } | null>(null);
  const [movements, setMovements] = useState<MovementRow[] | null>(null);

  useEffect(() => {
    if (!perms) return;
    let cancelled = false;

    const seesOrders = canAny(perms, ['orders.read', 'orders.ship']);
    const seesStock = canAny(perms, ['stock.read', 'stock.adjust']);
    const seesSync = can(perms, 'sync.manage');
    const seesDrivers = canAny(perms, ['orders.settle', 'orders.ship']);

    async function load() {
      const none = Promise.resolve({ data: null, count: null } as { data: unknown[] | null; count: number | null });
      const lateBefore = new Date(Date.now() - COURIER_LATE_DAYS * 86_400_000).toISOString();

      const [toShip, late, drivers, owed, outs, low, sync, orders, feed] = await Promise.all([
        seesOrders
          ? supabase.from('v_packing_queue').select('created_at').in('fulfillment_status', TO_SHIP).limit(500)
          : none,
        seesOrders
          ? supabase
              .from('v_order_list')
              .select('id', { count: 'exact', head: true })
              .eq('stage', 'on_the_road')
              .neq('courier', 'own')
              .lt('stage_since', lateBefore)
          : none,
        seesDrivers
          ? supabase
              .from('v_order_list')
              .select('total_egp, shipping_egp, payment_method, payment_status')
              .eq('stage', 'on_the_road')
              .eq('courier', 'own')
              .limit(500)
          : none,
        seesOrders
          ? supabase
              .from('v_order_list')
              .select('total_egp, shipping_egp')
              .eq('stage', 'delivered')
              .eq('payment_status', 'pending')
              .limit(2000)
          : none,
        seesStock ? supabase.from('v_stock_outs').select('status').in('status', ['out', 'overdue']).limit(500) : none,
        seesStock ? supabase.from('v_low_stock').select('variant_id', { count: 'exact', head: true }) : none,
        seesSync ? supabase.from('sync_issues').select('id', { count: 'exact', head: true }).eq('status', 'open') : none,
        supabase.from('orders').select('total_egp').gte('created_at', cairoStartOfDay()).is('cancelled_at', null),
        seesStock
          ? supabase
              .from('v_stock_movement_feed')
              .select('id, created_at, quantity_delta, reason, sku, product_title, staff_name')
              .order('created_at', { ascending: false })
              .limit(8)
          : none,
      ]);

      if (cancelled) return;

      const list: Todo[] = [];

      if (seesOrders) {
        const rows = (toShip.data ?? []) as Array<{ created_at: string }>;
        const seen = Date.parse(readSeenAt());
        const fresh = rows.filter((row) => Date.parse(row.created_at) > seen).length;
        list.push({
          key: 'toShip',
          icon: PackageCheck,
          count: rows.length,
          label: t('home.toShip'),
          detail: fresh > 0 ? t('home.newSince', { count: fresh }) : null,
          to: '/queue',
          tone: fresh > 0 ? 'back' : 'wait',
        });

        list.push({
          key: 'late',
          icon: Truck,
          count: late.count ?? 0,
          label: t('home.lateWithCourier', { days: COURIER_LATE_DAYS }),
          detail: null,
          to: '/orders?tab=on_the_road',
          tone: 'back',
        });

        const owedRows = (owed.data ?? []) as Array<{ total_egp: number; shipping_egp: number }>;
        const owedSum = owedRows.reduce((sum, row) => sum + Number(row.total_egp) + Number(row.shipping_egp), 0);
        list.push({
          key: 'owed',
          icon: Banknote,
          count: owedRows.length,
          label: t('home.owed'),
          detail: owedRows.length > 0 ? formatEGP(owedSum, locale) : null,
          to: '/orders?tab=owed',
          tone: 'wait',
        });
      }

      if (seesDrivers) {
        const rows = (drivers.data ?? []) as Array<{
          total_egp: number;
          shipping_egp: number;
          payment_method: string | null;
          payment_status: string;
        }>;
        const cash = rows
          .filter((row) => row.payment_method === 'cod' && row.payment_status === 'pending')
          .reduce((sum, row) => sum + Number(row.total_egp) + Number(row.shipping_egp), 0);
        list.push({
          key: 'drivers',
          icon: HandCoins,
          count: rows.length,
          label: t('home.withDrivers'),
          detail: cash > 0 ? t('home.cashHeld', { amount: formatEGP(cash, locale) }) : null,
          to: '/queue',
          tone: 'road',
        });
      }

      if (seesStock) {
        const outRows = (outs.data ?? []) as Array<{ status: string }>;
        const overdue = outRows.filter((row) => row.status === 'overdue').length;
        list.push({
          key: 'outs',
          icon: PackageOpen,
          count: outRows.length,
          label: t('home.outNotBack'),
          detail: overdue > 0 ? t('home.overdueCount', { count: overdue }) : null,
          to: '/stock?tab=out',
          tone: overdue > 0 ? 'back' : 'wait',
        });

        list.push({
          key: 'low',
          icon: Boxes,
          count: low.count ?? 0,
          label: t('home.lowStock'),
          detail: null,
          to: '/stock?state=attention',
          tone: 'wait',
        });
      }

      if (seesSync) {
        list.push({
          key: 'sync',
          icon: RefreshCw,
          count: sync.count ?? 0,
          label: t('home.syncIssues'),
          detail: null,
          to: '/sync',
          tone: 'back',
        });
      }

      const orderRows = (orders.data ?? []) as Array<{ total_egp: number }>;
      setToday({
        sales: orderRows.length,
        revenue: orderRows.reduce((sum, row) => sum + Number(row.total_egp), 0),
      });
      setTodos(list);
      setMovements((feed.data ?? []) as MovementRow[]);
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [perms, t, locale]);

  if (!todos || !today) return <Spinner label={t('app.loading')} />;

  const waiting = todos.filter((todo) => todo.count > 0);
  const clear = todos.filter((todo) => todo.count === 0);
  const hour = new Date().getHours();
  const firstName = (identity?.full_name ?? '').split(' ')[0];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-extrabold">
          {hour < 12 ? t('home.morning') : t('home.evening')}
          {firstName ? (
            <>
              {'، '}
              <bdi>{firstName}</bdi>
            </>
          ) : null}
        </h1>
        <p className="text-sm text-stone-500">
          {/* "السبت ٤ أكتوبر" reads better here than 04/10/2026; Latin digits
              as everywhere else in the CRM. */}
          {new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
            timeZone: 'Africa/Cairo',
          }).format(new Date())}
        </p>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-extrabold text-stone-600">{t('home.todo')}</h2>

        {waiting.length === 0 ? (
          <Card className="flex items-center gap-3 border-emerald-200 bg-emerald-50">
            <CircleCheck className="size-6 text-emerald-700" />
            <p className="font-bold text-emerald-800">{t('home.allClear')}</p>
          </Card>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {waiting.map((todo) => {
              const Icon = todo.icon;
              const style = TONE_STYLES[todo.tone];
              return (
                <Link
                  key={todo.key}
                  to={todo.to}
                  className={cx(
                    'flex items-center gap-3 rounded-2xl border p-4 transition-transform active:scale-[0.99]',
                    style.card,
                  )}
                >
                  <span className={cx('flex size-11 shrink-0 items-center justify-center rounded-xl', style.icon)}>
                    <Icon className="size-6" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-bold">{todo.label}</span>
                    {todo.detail ? <span className="block text-xs text-stone-700">{todo.detail}</span> : null}
                  </span>
                  <span className="tabular text-2xl font-extrabold">{todo.count}</span>
                  <ChevronLeft className="size-4 shrink-0 text-stone-400 ltr:rotate-180" />
                </Link>
              );
            })}
          </div>
        )}

        {/* What is already done, small, so it still says "nothing waiting here". */}
        {clear.length > 0 && waiting.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {clear.map((todo) => (
              <span
                key={todo.key}
                className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1 text-xs text-stone-500 ring-1 ring-duch-line"
              >
                <CircleCheck className="size-3.5 text-emerald-600" />
                {todo.label}
              </span>
            ))}
          </div>
        ) : null}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-extrabold text-stone-600">{t('home.today')}</h2>
        <div className="grid grid-cols-2 gap-3">
          <Card>
            <p className="text-xs font-semibold text-stone-500">{t('dashboard.salesToday')}</p>
            <p className="tabular mt-1 text-2xl font-extrabold">{today.sales}</p>
          </Card>
          <Card>
            <p className="text-xs font-semibold text-stone-500">{t('dashboard.revenueToday')}</p>
            <p className="tabular mt-1 text-2xl font-extrabold">{formatEGP(today.revenue, locale)}</p>
          </Card>
        </div>
      </section>

      {movements && movements.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-sm font-extrabold text-stone-600">{t('dashboard.recentMovements')}</h2>
          <Card className="p-0">
            <ul className="divide-y divide-duch-line">
              {movements.map((movement) => (
                <li key={movement.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                  <span
                    className={cx(
                      'tabular w-10 text-end font-extrabold',
                      movement.quantity_delta > 0 ? 'text-emerald-600' : 'text-red-600',
                    )}
                  >
                    {movement.quantity_delta > 0 ? '+' : ''}
                    {movement.quantity_delta}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">
                      <bdi>{movement.product_title}</bdi>
                    </span>
                    <span className="block text-xs text-stone-500">
                      <Code>{movement.sku}</Code>
                      {movement.staff_name ? (
                        <>
                          {' · '}
                          <bdi>{movement.staff_name}</bdi>
                        </>
                      ) : null}
                    </span>
                  </span>
                  <Badge>{t(`reason.${movement.reason}`)}</Badge>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      ) : null}
    </div>
  );
}
