import { NavLink, Outlet } from 'react-router';
import { useGetIdentity, useLogout } from '@refinedev/core';
import { can } from '@duch/shared';
import { useLocale } from '../i18n';
import type { StaffIdentity } from '../providers/authProvider';
import { Button, cx } from './ui';

interface NavItem {
  to: string;
  labelKey: string;
  capability: string;
  icon: string;
}

const NAV_ITEMS: NavItem[] = [
  { to: '/', labelKey: 'nav.dashboard', capability: 'stock.read', icon: '▦' },
  { to: '/sell', labelKey: 'nav.sell', capability: 'sales.create', icon: '＋' },
  { to: '/queue', labelKey: 'nav.queue', capability: 'orders.queue', icon: '☰' },
  { to: '/returns', labelKey: 'nav.returns', capability: 'orders.queue', icon: '↩' },
  { to: '/stock', labelKey: 'nav.stock', capability: 'stock.read', icon: '▤' },
  { to: '/products', labelKey: 'nav.products', capability: 'products.read', icon: '✚' },
  { to: '/settlements', labelKey: 'nav.settlements', capability: 'settlements.manage', icon: '₤' },
  { to: '/sync', labelKey: 'nav.sync', capability: 'sync.read', icon: '⇄' },
];

export function Layout() {
  const { t, locale, setLocale } = useLocale();
  const { data: identity } = useGetIdentity<StaffIdentity>();
  const { mutate: logout } = useLogout();

  const visible = NAV_ITEMS.filter((item) => can(identity?.role, item.capability));

  return (
    <div className="min-h-dvh">
      <header className="no-print sticky top-0 z-30 border-b border-duch-line bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">
          <span className="text-base font-extrabold tracking-tight">{t('app.name')}</span>

          <nav className="ms-auto hidden items-center gap-1 sm:flex">
            {visible.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) =>
                  cx(
                    'rounded-lg px-3 py-2 text-sm font-semibold transition-colors',
                    isActive ? 'bg-duch-ink text-white' : 'text-stone-600 hover:bg-stone-100',
                  )
                }
              >
                {t(item.labelKey)}
              </NavLink>
            ))}
          </nav>

          <div className="ms-auto flex items-center gap-2 sm:ms-0">
            <Button
              variant="ghost"
              className="min-h-9 px-2 text-xs"
              onClick={() => setLocale(locale === 'ar' ? 'en' : 'ar')}
              // The label is the language you would switch TO, which is the
              // convention people expect from a single toggle.
              aria-label={t('app.language')}
            >
              {t('app.language')}
            </Button>
            <Button variant="ghost" className="min-h-9 px-2 text-xs" onClick={() => logout()}>
              {t('app.signOut')}
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 pb-24 pt-5 sm:pb-8">
        <Outlet />
      </main>

      {/* On phones the navigation sits at the bottom, within thumb reach of
          someone holding the device one-handed behind the counter. */}
      <nav className="no-print fixed inset-x-0 bottom-0 z-30 border-t border-duch-line bg-white sm:hidden">
        <div className="flex">
          {visible.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                cx(
                  'flex flex-1 flex-col items-center gap-0.5 px-1 py-2 text-[11px] font-semibold',
                  isActive ? 'text-duch-ink' : 'text-stone-500',
                )
              }
            >
              <span aria-hidden className="text-base leading-none">
                {item.icon}
              </span>
              {t(item.labelKey)}
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  );
}
