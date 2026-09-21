import { useEffect, useState } from 'react';
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
import { Orders } from './pages/Orders';
import { PackingQueue } from './pages/PackingQueue';
import { Pending } from './pages/Pending';
import { Products } from './pages/Products';
import { Reports } from './pages/Reports';
import { Returns } from './pages/Returns';
import { Settlements } from './pages/Settlements';
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
  const { data: identity, isLoading, refetch } = useGetIdentity<StaffIdentity>();
  const { t } = useLocale();
  const [retried, setRetried] = useState(false);

  // Signing out leaves a null identity in the query cache, because there was
  // no session to read one from. Signing back in does not clear it, so the
  // first render after a successful login reads that stale null and sends the
  // person to the holding screen - where they sit, being told their account
  // needs approving, until they happen to reload the page.
  //
  // <Authenticated> has already established that there is a session by the
  // time this renders, so a null identity here cannot mean "not signed in".
  // It can only be the answer from before. Fetch it again rather than acting
  // on it - once, and waiting for it to settle, so a genuinely missing staff
  // row still reaches the holding screen instead of spinning forever.
  useEffect(() => {
    if (isLoading || identity != null || retried) return;

    let cancelled = false;
    void refetch().finally(() => {
      if (!cancelled) setRetried(true);
    });

    return () => {
      cancelled = true;
    };
  }, [isLoading, identity, retried, refetch]);

  if (isLoading || (identity == null && !retried)) {
    return <Spinner label={t('app.loading')} />;
  }
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
        { name: 'orders', list: '/orders', meta: { label: 'nav.orders' } },
        { name: 'packing', list: '/queue', meta: { label: 'nav.queue' } },
        { name: 'returns', list: '/returns', meta: { label: 'nav.returns' } },
        { name: 'settlements', list: '/settlements', meta: { label: 'nav.settlements' } },
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
            <Route path="/orders" element={<Orders />} />
            <Route path="/queue" element={<PackingQueue />} />
            <Route path="/returns" element={<Returns />} />
            <Route path="/settlements" element={<Settlements />} />
            <Route path="/stock" element={<Stock />} />
            <Route path="/products" element={<Products />} />
            <Route path="/reports" element={<Reports />} />
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
