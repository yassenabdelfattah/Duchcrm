import { useEffect, useState, type ComponentType } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { useGetIdentity, useLogout } from '@refinedev/core';
import {
  Boxes,
  ChartColumn,
  House,
  LayoutGrid,
  LogOut,
  PackageCheck,
  ReceiptText,
  RefreshCw,
  ShoppingBag,
  Undo2,
  Users,
  Volume2,
  VolumeX,
  Wallet,
  X,
} from 'lucide-react';
import { can, canAny, type Permission } from '@duch/shared';
import { useLocale } from '../i18n';
import { useQueueAlert } from '../hooks/useQueueAlert';
import type { StaffIdentity } from '../providers/authProvider';
import { cx } from './ui';

interface NavItem {
  to: string;
  labelKey: string;
  /** Shown to anyone holding one of these; null for every active staff member. */
  permissions: Permission[] | null;
  icon: ComponentType<{ className?: string; strokeWidth?: number }>;
}

/**
 * Every screen, in the order the phone's bottom bar fills from: the first
 * four someone can open become their tabs, everything else goes under
 * "More". So a cashier gets sell, orders, packing, stock; a packer, who
 * cannot sell, gets orders, packing, stock and home.
 */
const NAV_ITEMS: NavItem[] = [
  { to: '/sell', labelKey: 'nav.sell', permissions: ['sales.create'], icon: ShoppingBag },
  // Settling and editing are gated inside the screen, and by the database
  // underneath it.
  { to: '/orders', labelKey: 'nav.orders', permissions: ['orders.read'], icon: ReceiptText },
  // Whoever sees orders sees the queue; the buttons in it need orders.ship.
  { to: '/queue', labelKey: 'nav.queue', permissions: ['orders.ship', 'orders.read'], icon: PackageCheck },
  { to: '/stock', labelKey: 'nav.stock', permissions: ['stock.read', 'stock.adjust', 'products.manage'], icon: Boxes },
  { to: '/', labelKey: 'nav.dashboard', permissions: null, icon: House },
  { to: '/returns', labelKey: 'nav.returns', permissions: ['returns.manage', 'orders.read'], icon: Undo2 },
  { to: '/reports', labelKey: 'nav.reports', permissions: ['reports.read'], icon: ChartColumn },
  { to: '/settlements', labelKey: 'nav.settlements', permissions: ['settlements.manage'], icon: Wallet },
  { to: '/sync', labelKey: 'nav.sync', permissions: ['sync.manage'], icon: RefreshCw },
  { to: '/staff', labelKey: 'nav.staff', permissions: ['staff.manage'], icon: Users },
];

/** The desktop menu keeps the order people know: home first. */
const DESKTOP_ORDER = ['/', '/sell', '/orders', '/queue', '/returns', '/stock', '/reports', '/settlements', '/sync', '/staff'];

const BASE_TITLE = 'دش - نظام الإدارة';

function isActivePath(pathname: string, to: string): boolean {
  return to === '/' ? pathname === '/' : pathname === to || pathname.startsWith(`${to}/`);
}

export function Layout() {
  const { t } = useLocale();
  const { data: identity } = useGetIdentity<StaffIdentity>();
  const { mutate: logout } = useLogout();
  const { pathname } = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);

  const visible = NAV_ITEMS.filter(
    (item) => item.permissions === null || canAny(identity?.permissions, item.permissions),
  );
  const desktop = [...visible].sort((a, b) => DESKTOP_ORDER.indexOf(a.to) - DESKTOP_ORDER.indexOf(b.to));
  const tabs = visible.slice(0, 4);
  const more = visible.slice(4);

  const seesQueue = visible.some((item) => item.to === '/queue');
  const ships = can(identity?.permissions, 'orders.ship');
  const queue = useQueueAlert({ enabled: seesQueue, alerts: ships });

  // A new order shows in the browser tab too, for the till left on another tab.
  useEffect(() => {
    document.title = queue.unseen > 0 ? `(${queue.unseen}) ${BASE_TITLE}` : BASE_TITLE;
  }, [queue.unseen]);

  // Moving to another screen closes the sheet.
  useEffect(() => {
    setMoreOpen(false);
  }, [pathname]);

  const moreActive = more.some((item) => isActivePath(pathname, item.to));

  function badgeFor(to: string) {
    if (to !== '/queue' || queue.waiting === 0) return null;
    return (
      <span
        className={cx(
          'tabular inline-flex min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-bold leading-5 text-white',
          queue.unseen > 0 ? 'animate-pulse bg-duch-accent' : 'bg-stone-500',
        )}
      >
        {queue.waiting}
      </span>
    );
  }

  return (
    <div className="min-h-dvh">
      <header className="no-print sticky top-0 z-30 border-b border-duch-line bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-2.5">
          <span className="flex items-center gap-2">
            <img src="/logo-black.png" alt="" className="h-8 w-auto" />
            <span className="whitespace-nowrap text-base font-extrabold tracking-tight">{t('app.name')}</span>
          </span>

          <nav className="ms-auto hidden items-center gap-0.5 xl:flex">
            {desktop.map((item) => {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === '/'}
                  className={({ isActive }) =>
                    cx(
                      'flex items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-2 text-sm font-semibold transition-colors',
                      isActive ? 'bg-duch-ink text-white' : 'text-stone-600 hover:bg-stone-100',
                    )
                  }
                >
                  <Icon className="size-4" strokeWidth={2} />
                  {t(`navShort.${item.to === '/' ? 'dashboard' : item.to.slice(1)}`)}
                  {badgeFor(item.to)}
                </NavLink>
              );
            })}
          </nav>

          <button
            type="button"
            onClick={() => logout()}
            className="ms-auto hidden items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-2 text-xs font-semibold text-stone-500 hover:bg-stone-100 sm:flex xl:ms-0"
          >
            <LogOut className="size-4" />
            {t('app.signOut')}
          </button>
        </div>

        {/* Tablets: the full menu as one scrolling row under the header. */}
        <nav className="hidden overflow-x-auto border-t border-duch-line px-2 sm:flex xl:hidden">
          {desktop.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) =>
                  cx(
                    'flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-semibold',
                    isActive ? 'border-duch-ink text-duch-ink' : 'border-transparent text-stone-500',
                  )
                }
              >
                <Icon className="size-4" />
                {t(`navShort.${item.to === '/' ? 'dashboard' : item.to.slice(1)}`)}
                {badgeFor(item.to)}
              </NavLink>
            );
          })}
        </nav>
      </header>

      <main className="mx-auto max-w-6xl px-4 pb-28 pt-5 sm:pb-8">
        <Outlet />
      </main>

      {/* Phones: four tabs and More, within thumb reach of someone holding
          the device one-handed behind the counter. */}
      <nav
        className="no-print fixed inset-x-0 bottom-0 z-30 border-t border-duch-line bg-white/95 backdrop-blur sm:hidden"
        style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
      >
        <div className="grid" style={{ gridTemplateColumns: `repeat(${tabs.length + 1}, minmax(0, 1fr))` }}>
          {tabs.map((item) => {
            const Icon = item.icon;
            const active = isActivePath(pathname, item.to);
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className="relative flex flex-col items-center gap-1 pb-2 pt-2.5"
              >
                <span
                  className={cx(
                    'relative flex h-8 w-14 items-center justify-center rounded-full transition-colors',
                    active ? 'bg-duch-ink text-white' : 'text-stone-500',
                  )}
                >
                  <Icon className="size-5" strokeWidth={active ? 2.4 : 2} />
                  {item.to === '/queue' && queue.waiting > 0 ? (
                    <span className="absolute -top-1.5 end-1">{badgeFor('/queue')}</span>
                  ) : null}
                </span>
                <span
                  className={cx(
                    'max-w-full truncate px-1 text-[11px] leading-none',
                    active ? 'font-bold text-duch-ink' : 'font-semibold text-stone-500',
                  )}
                >
                  {t(`navShort.${item.to === '/' ? 'dashboard' : item.to.slice(1)}`)}
                </span>
              </NavLink>
            );
          })}

          {/* Always there: it also holds the sound switch and signing out. */}
          <button
            type="button"
            onClick={() => setMoreOpen(true)}
            className="flex flex-col items-center gap-1 pb-2 pt-2.5"
          >
            <span
              className={cx(
                'flex h-8 w-14 items-center justify-center rounded-full',
                moreActive ? 'bg-duch-ink text-white' : 'text-stone-500',
              )}
            >
              <LayoutGrid className="size-5" />
            </span>
            <span
              className={cx(
                'text-[11px] leading-none',
                moreActive ? 'font-bold text-duch-ink' : 'font-semibold text-stone-500',
              )}
            >
              {t('nav.more')}
            </span>
          </button>
        </div>
      </nav>

      {moreOpen ? (
        <div className="fixed inset-0 z-40 sm:hidden" role="dialog" aria-modal="true" aria-label={t('nav.more')}>
          <button
            type="button"
            aria-label={t('app.close')}
            className="absolute inset-0 bg-black/40"
            onClick={() => setMoreOpen(false)}
          />
          <div
            className="absolute inset-x-0 bottom-0 rounded-t-3xl bg-white p-4 shadow-2xl"
            style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom, 0px))' }}
          >
            <div className="mx-auto mb-4 h-1.5 w-10 rounded-full bg-stone-200" />

            <div className="mb-4 flex items-center gap-3">
              <img src="/logo-black.png" alt="" className="h-10 w-auto" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-bold">
                  <bdi>{identity?.full_name}</bdi>
                </p>
                <p className="text-xs text-stone-500">{identity?.role_name ?? ''}</p>
              </div>
              <button
                type="button"
                onClick={() => setMoreOpen(false)}
                aria-label={t('app.close')}
                className="rounded-full p-2 text-stone-500 hover:bg-stone-100"
              >
                <X className="size-5" />
              </button>
            </div>

            {more.length > 0 ? (
              <div className="grid grid-cols-3 gap-2">
                {more.map((item) => {
                  const Icon = item.icon;
                  const active = isActivePath(pathname, item.to);
                  return (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      end={item.to === '/'}
                      className={cx(
                        'flex flex-col items-center gap-2 rounded-2xl border px-2 py-4 text-center text-xs font-semibold',
                        active ? 'border-duch-ink bg-duch-ink text-white' : 'border-duch-line bg-stone-50 text-duch-ink',
                      )}
                    >
                      <Icon className="size-6" />
                      {t(item.labelKey)}
                    </NavLink>
                  );
                })}
              </div>
            ) : null}

            <div className="mt-4 space-y-1 border-t border-duch-line pt-3">
              {ships ? (
                <button
                  type="button"
                  onClick={queue.toggleSound}
                  className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-sm font-semibold hover:bg-stone-50"
                >
                  {queue.soundOn ? <Volume2 className="size-5" /> : <VolumeX className="size-5 text-stone-400" />}
                  <span className="flex-1 text-start">{t('nav.newOrderSound')}</span>
                  <span className={cx('text-xs', queue.soundOn ? 'text-emerald-700' : 'text-stone-400')}>
                    {queue.soundOn ? t('nav.on') : t('nav.off')}
                  </span>
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => logout()}
                className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-sm font-semibold text-red-700 hover:bg-red-50"
              >
                <LogOut className="size-5" />
                <span className="flex-1 text-start">{t('app.signOut')}</span>
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
