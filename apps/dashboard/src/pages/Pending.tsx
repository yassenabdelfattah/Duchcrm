import { useLogout } from '@refinedev/core';
import { useLocale } from '../i18n';
import { Button, Card } from '../components/ui';

/**
 * Where a newly signed-up account lands.
 *
 * New accounts are created inactive with no usable role, so without this
 * screen they would see a dashboard where every query silently returns
 * nothing - which looks like a broken app rather than a deliberate wait.
 */
export function Pending() {
  const { t } = useLocale();
  const { mutate: logout } = useLogout();

  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <Card className="max-w-sm text-center">
        <h1 className="text-base font-bold">{t('auth.pendingTitle')}</h1>
        <p className="mt-2 text-sm text-stone-600">{t('auth.pendingBody')}</p>
        <Button variant="secondary" className="mt-5 w-full" onClick={() => logout()}>
          {t('app.signOut')}
        </Button>
      </Card>
    </div>
  );
}
