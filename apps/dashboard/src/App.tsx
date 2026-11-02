import { useEffect, useRef, useState } from 'react';
import { Authenticated, Refine, useGetIdentity, useLogout } from '@refinedev/core';
import routerProvider from '@refinedev/react-router';
import { dataProvider } from '@refinedev/supabase';
import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router';
import { supabase } from './lib/supabase';
import { authProvider, type StaffIdentity } from './providers/authProvider';
import { accessControlProvider } from './providers/accessControlProvider';
import { LocaleProvider, buildI18nProvider, useLocale } from './i18n';
import { Layout } from './components/Layout';
import { Button, Card, Spinner } from './components/ui';
import { Dashboard } from './pages/Dashboard';
import { Login } from './pages/Login';
import { Orders } from './pages/Orders';
import { PackingQueue } from './pages/PackingQueue';
import { Pending } from './pages/Pending';
import { Reports } from './pages/Reports';
import { Log } from './pages/Log';
import { Returns } from './pages/Returns';
import { Settlements } from './pages/Settlements';
import { Staff } from './pages/Staff';
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
  const { data: identity, isLoading, isError, refetch } = useGetIdentity<StaffIdentity>();
  const { t } = useLocale();
  const [retried, setRetried] = useState(false);
  const approved = Boolean(identity?.is_active && identity.permissions);
  // refetch is a new function on every render; an effect that depends on it
  // re-runs every render, and while reads keep failing that is a request
  // loop. Held in a ref, and the one extra read started only once.
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;
  const started = useRef(false);

  // Anything short of "approved" is read once more before it is acted on.
  //
  // Signing out leaves a null identity in the query cache, because there was
  // no session to read one from; a read that failed leaves whatever came
  // before it. Signing back in clears neither, so the first render after a
  // successful login can be reading an answer from before - and send someone
  // whose account is fine to the holding screen, to be told it needs
  // approving. Fetched again, once, and waited for, so a genuinely inactive
  // account still reaches the holding screen instead of spinning forever.
  useEffect(() => {
    if (isLoading || approved || started.current) return;
    started.current = true;
    void refetchRef.current().finally(() => setRetried(true));
  }, [isLoading, approved]);

  if (approved) return <Outlet />;
  if (isLoading || !retried) return <Spinner label={t('app.loading')} />;
  // Could not read the account at all: say so, rather than "not approved".
  if (isError) return <CouldNotLoad onRetry={() => void refetch()} />;
  return <Navigate to="/pending" replace />;
}

function CouldNotLoad({ onRetry }: { onRetry: () => void }) {
  const { t } = useLocale();
  const { mutate: logout } = useLogout();
  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <Card className="max-w-sm space-y-3 text-center">
        <h1 className="text-base font-bold">{t('auth.loadFailedTitle')}</h1>
        <p className="text-sm text-stone-600">{t('auth.loadFailedBody')}</p>
        <Button className="w-full" onClick={onRetry}>
          {t('app.retry')}
        </Button>
        <Button variant="secondary" className="w-full" onClick={() => logout()}>
          {t('app.signOut')}
        </Button>
      </Card>
    </div>
  );
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
        { name: 'products', list: '/stock', meta: { label: 'nav.stock' } },
        { name: 'stock', list: '/stock', meta: { label: 'nav.stock' } },
        { name: 'sale', create: '/sell', meta: { label: 'nav.sell' } },
        { name: 'orders', list: '/orders', meta: { label: 'nav.orders' } },
        { name: 'packing', list: '/queue', meta: { label: 'nav.queue' } },
        { name: 'returns', list: '/returns', meta: { label: 'nav.returns' } },
        { name: 'settlements', list: '/settlements', meta: { label: 'nav.settlements' } },
        { name: 'sync_issues', list: '/sync', meta: { label: 'nav.sync' } },
        { name: 'staff', list: '/staff', meta: { label: 'nav.staff' } },
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
            {/* Products and stock are one page now; old links still land. */}
            <Route path="/products" element={<Navigate to="/stock" replace />} />
            <Route path="/reports" element={<Reports />} />
            <Route path="/log" element={<Log />} />
            <Route path="/sync" element={<SyncIssues />} />
            <Route path="/staff" element={<Staff />} />
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
