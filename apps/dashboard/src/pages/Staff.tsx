import { useEffect, useState } from 'react';
import { useGetIdentity } from '@refinedev/core';
import { STAFF_ROLES, formatDate, type StaffRole } from '@duch/shared';
import { supabase } from '../lib/supabase';
import { useLocale } from '../i18n';
import type { StaffIdentity } from '../providers/authProvider';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
} from '../components/ui';

interface StaffRow {
  id: string;
  email: string;
  full_name: string;
  phone: string | null;
  role: StaffRole;
  is_active: boolean;
  created_at: string;
}

/**
 * Role and activation, the only two things this screen changes. Creating a
 * login stays a Supabase dashboard action, deliberately - see B4 in
 * getting-started.md for why there is no in-app sign-up form. A new account
 * shows up here on its own, inactive, because the signup trigger already
 * makes one; this screen exists to get it the rest of the way.
 */
export function Staff() {
  const { t, locale } = useLocale();
  const { data: identity } = useGetIdentity<StaffIdentity>();

  const [rows, setRows] = useState<StaffRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<StaffRow | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);

    supabase
      .rpc('staff_directory')
      .then(({ data, error: rpcError }) => {
        if (cancelled) return;
        if (rpcError) {
          setError(rpcError.message);
          return;
        }
        // Pending accounts are the reason this screen exists, so they lead.
        const sorted = [...((data ?? []) as StaffRow[])].sort((a, b) => {
          if (a.is_active !== b.is_active) return a.is_active ? 1 : -1;
          return a.full_name.localeCompare(b.full_name);
        });
        setRows(sorted);
      });

    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-extrabold">{t('staff.title')}</h1>
      <p className="rounded-lg bg-stone-50 px-3 py-2 text-xs text-stone-600">{t('staff.addHint')}</p>

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      {!rows ? (
        <Spinner label={t('app.loading')} />
      ) : rows.length === 0 ? (
        <EmptyState title={t('staff.empty')} />
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full min-w-[40rem] text-sm">
            <thead className="border-b border-duch-line bg-stone-50 text-xs uppercase text-stone-500">
              <tr>
                <th className="px-4 py-3 text-start font-semibold">{t('staff.name')}</th>
                <th className="px-4 py-3 text-start font-semibold">{t('staff.email')}</th>
                <th className="px-4 py-3 text-start font-semibold">{t('staff.role')}</th>
                <th className="px-4 py-3 text-start font-semibold">{t('staff.status')}</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-duch-line">
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3">
                    <span className="block font-semibold">
                      {row.full_name}
                      {row.id === identity?.id ? (
                        <span className="ms-2">
                          <Badge>{t('staff.you')}</Badge>
                        </span>
                      ) : null}
                    </span>
                    {row.phone ? <span className="text-xs text-stone-500">{row.phone}</span> : null}
                  </td>
                  <td className="px-4 py-3 text-stone-600" dir="ltr">
                    {row.email}
                  </td>
                  <td className="px-4 py-3">{t(`role.${row.role}`)}</td>
                  <td className="px-4 py-3">
                    <Badge tone={row.is_active ? 'good' : 'warn'}>
                      {row.is_active ? t('staff.active') : t('staff.pending')}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-end">
                    <Button
                      variant="secondary"
                      className="min-h-9 text-xs"
                      onClick={() => setEditing(row)}
                    >
                      {t('staff.edit')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <EditDialog
        row={editing}
        locale={locale}
        onClose={() => setEditing(null)}
        onDone={() => {
          setEditing(null);
          setReloadToken((token) => token + 1);
        }}
      />
    </div>
  );
}

function EditDialog({
  row,
  locale,
  onClose,
  onDone,
}: {
  row: StaffRow | null;
  locale: 'ar' | 'en';
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useLocale();
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState<StaffRole>('sales');
  const [isActive, setIsActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!row) return;
    setFullName(row.full_name);
    setPhone(row.phone ?? '');
    setRole(row.role);
    setIsActive(row.is_active);
    setError(null);
  }, [row]);

  if (!row) return null;

  // Captured so the null check above still holds inside submit() - see the
  // same note in Stock.tsx's AdjustDialog.
  const target = row;

  async function submit() {
    setSaving(true);
    setError(null);

    const { error: updateError } = await supabase
      .from('staff')
      .update({
        full_name: fullName.trim() || target.full_name,
        phone: phone.trim() || null,
        role,
        is_active: isActive,
      })
      .eq('id', target.id);

    setSaving(false);

    if (updateError) {
      setError(updateError.message);
      return;
    }

    onDone();
  }

  return (
    <Modal open title={t('staff.editTitle', { name: row.full_name })} onClose={onClose}>
      <div className="space-y-3">
        {!row.is_active ? (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            {t('staff.activateAndSetRole')}
          </p>
        ) : null}

        <Field label={t('staff.name')}>
          <Input value={fullName} onChange={(event) => setFullName(event.target.value)} />
        </Field>

        <Field label={t('staff.email')}>
          <Input value={row.email} disabled dir="ltr" className="bg-stone-50 text-stone-500" />
        </Field>

        <Field label={t('staff.phone')}>
          <Input value={phone} onChange={(event) => setPhone(event.target.value)} dir="ltr" />
        </Field>

        <Field label={t('staff.role')}>
          <Select value={role} onChange={(event) => setRole(event.target.value as StaffRole)}>
            {STAFF_ROLES.map((value) => (
              <option key={value} value={value}>
                {t(`role.${value}`)}
              </option>
            ))}
          </Select>
        </Field>

        <label className="flex items-center gap-2 text-sm font-semibold text-stone-600">
          <input
            type="checkbox"
            checked={isActive}
            onChange={(event) => setIsActive(event.target.checked)}
            className="size-4 accent-duch-ink"
          />
          {t('staff.active')}
        </label>

        <p className="text-xs text-stone-500">
          {t('staff.createdAt')}: {formatDate(row.created_at, locale)}
        </p>

        {error ? <ErrorNote>{error}</ErrorNote> : null}

        <div className="flex gap-2 pt-1">
          <Button className="flex-1" onClick={submit} disabled={saving}>
            {saving ? t('app.loading') : t('app.save')}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {t('app.cancel')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
