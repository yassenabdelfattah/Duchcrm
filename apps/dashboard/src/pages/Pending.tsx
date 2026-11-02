import { useEffect, useRef } from 'react';
import { Navigate } from 'react-router';
import { useGetIdentity, useLogout } from '@refinedev/core';
import type { StaffIdentity } from '../providers/authProvider';
import { useLocale } from '../i18n';
import { Button, Card } from '../components/ui';

/**
 * Where a newly signed-up account lands.
 *
 * New accounts are created inactive with no usable role, so without this
 * screen they would see a dashboard where every query silently returns
 * nothing - which looks like a broken app rather than a deliberate wait.
 *
 * It keeps asking. Approved while it is open - or sent here by an answer that
 * was out of date - the account goes straight in, without having to sign out
 * and back in to find out.
 */
export function Pending() {
  const { t } = useLocale();
  const { mutate: logout } = useLogout();
  const { data: identity, refetch, isFetching } = useGetIdentity<StaffIdentity>();
  // A new function every render: depended on directly, the effect below would
  // re-run - and read - on every render.
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;

  useEffect(() => {
    const check = () => void refetchRef.current();
    check();
    const timer = window.setInterval(check, 15_000);
    window.addEventListener('focus', check);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', check);
    };
  }, []);

  if (identity?.is_active && identity.permissions) return <Navigate to="/" replace />;

  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <Card className="max-w-sm space-y-3 text-center">
        <h1 className="text-base font-bold">{t('auth.pendingTitle')}</h1>
        <p className="text-sm text-stone-600">{t('auth.pendingBody')}</p>
        <Button className="w-full" onClick={() => void refetch()} disabled={isFetching}>
          {isFetching ? t('app.loading') : t('auth.checkAgain')}
        </Button>
        <Button variant="secondary" className="w-full" onClick={() => logout()}>
          {t('app.signOut')}
        </Button>
      </Card>
    </div>
  );
}
