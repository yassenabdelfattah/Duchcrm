import { Authenticated, Refine, useGetIdentity } from '@refinedev/core';
import routerProvider from '@refinedev/react-router';
import { dataProvider } from '@refinedev/supabase';
import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router';
import { supabase } from './lib/supabase';
import { authProvider, type StaffIdentity } from './providers/authProvider';
import { accessControlProvider } from './providers/accessControlProvider';
import { LocaleProvider, buildI18nProvider, useLocale } from './i18n';
import { Layout } from './components/Layout';
import { Spinner } from './components/ui';
import { Dashboard } from './pages/Dashboard';
import { Login } from './pages/Login';
import { PackingQueue } from './pages/PackingQueue';
import { Pending } from './pages/Pending';
import { Products } from './pages/Products';
import { Stock } from './pages/Stock';
import { StoreSale } from './pages/StoreSale';
import { SyncIssues } from './pages/SyncIssues';

/**
 * Sends a signed-in but not yet approved account to the holding screen.
 *
 * New signups are created inactive with no role, so without this they would
 * land on a dashboard where every query legitimately returns nothing - which
 * reads as a broken app rather than as "wait for your manager".
 */
function ActiveStaffGate() {
  const { data: identity, isLoading } = useGetIdentity<StaffIdentity>();
  const { t } = useLocale();

  if (isLoading) return <Spinner label={t('app.loading')} />;
  if (!identity?.is_active || !identity.role) return <Navigate to="/pending" replace />;

  return <Outlet />;
}

function RefineApp() {
  const locale = useLocale();

  return (
    <Refine
      dataProvider={dataProvider(supabase)}
      authProvider={authProvider}
      routerProvider={routerProvider}
      accessControlProvider={accessControlProvider}
      i18nProvider={buildI18nProvider(locale)}
      // Resources describe the app to Refine's own machinery. The navigation
      // in Layout is hand-built, so these mainly give access control and the
      // data hooks a stable name for each table.
      resources={[
        { name: 'products', list: '/products', meta: { label: 'nav.products' } },
        { name: 'stock', list: '/stock', meta: { label: 'nav.stock' } },
        { name: 'sale', create: '/sell', meta: { label: 'nav.sell' } },
        { name: 'orders', list: '/queue', meta: { label: 'nav.queue' } },
        { name: 'sync_issues', list: '/sync', meta: { label: 'nav.sync' } },
      ]}
      options={{
        syncWithLocation: true,
        warnWhenUnsavedChanges: true,
        disableTelemetry: true,
        projectId: 'duch-crm',
      }}
    >
      <Routes>
        <Route
          element={
            <Authenticated key="app" fallback={<Navigate to="/login" replace />}>
              <ActiveStaffGate />
            </Authenticated>
          }
        >
          <Route element={<Layout />}>
            <Route index element={<Dashboard />} />
            <Route path="/sell" element={<StoreSale />} />
            <Route path="/queue" element={<PackingQueue />} />
            <Route path="/stock" element={<Stock />} />
            <Route path="/products" element={<Products />} />
            <Route path="/sync" element={<SyncIssues />} />
          </Route>
        </Route>

        <Route
          path="/login"
          element={
            <Authenticated key="login" fallback={<Login />}>
              <Navigate to="/" replace />
            </Authenticated>
          }
        />

        <Route
          path="/pending"
          element={
            <Authenticated key="pending" fallback={<Navigate to="/login" replace />}>
              <Pending />
            </Authenticated>
          }
        />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Refine>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <LocaleProvider>
        <RefineApp />
      </LocaleProvider>
    </BrowserRouter>
  );
}
