import { useState, type FormEvent } from 'react';
import { useLogin } from '@refinedev/core';
import { useLocale } from '../i18n';
import { Button, Card, ErrorNote, Field, Input } from '../components/ui';

export function Login() {
  const { t } = useLocale();
  const { mutate: login, isPending } = useLogin<{ email: string; password: string }>();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [failed, setFailed] = useState(false);

  function submit(event: FormEvent) {
    event.preventDefault();
    setFailed(false);
    login(
      { email, password },
      {
        onSuccess: (result) => {
          if (!result?.success) setFailed(true);
        },
        onError: () => setFailed(true),
      },
    );
  }

  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <img src="/logo-black.png" alt="DUCH" className="mx-auto mb-2 h-24 w-auto" />
          <p className="text-sm text-stone-500">{t('app.name')}</p>
        </div>

        <Card>
          <form onSubmit={submit} className="space-y-3">
            <Field label={t('auth.email')}>
              <Input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="username"
                required
                dir="ltr"
              />
            </Field>

            <Field label={t('auth.password')}>
              <Input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                required
                dir="ltr"
              />
            </Field>

            {failed ? <ErrorNote>{t('auth.invalid')}</ErrorNote> : null}

            <Button type="submit" className="w-full" disabled={isPending}>
              {isPending ? t('auth.signingIn') : t('auth.signIn')}
            </Button>
          </form>
        </Card>

      </div>
    </div>
  );
}
