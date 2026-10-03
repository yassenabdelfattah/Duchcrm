import { useEffect, useMemo, useState } from 'react';
import { useGetIdentity } from '@refinedev/core';
import { PERMISSIONS, can, formatDate, type Permission } from '@duch/shared';
import { supabase } from '../lib/supabase';
import { arabicError } from '../lib/errors';
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
  cx,
} from '../components/ui';

interface StaffRow {
  id: string;
  email: string;
  full_name: string;
  phone: string | null;
  role: string | null;
  role_id: string | null;
  is_active: boolean;
  is_owner: boolean;
  created_at: string;
}

interface RoleRow {
  id: string;
  builtin_role: string | null;
  name_ar: string;
  permissions: string[];
}

/** Permission keys use dots; the dictionary nests on dots, so they are looked up with underscores. */
function permissionLabel(permission: string, t: (k: string) => string): string {
  return permission === '*' ? t('permission.all') : t(`permission.${permission.replace('.', '_')}`);
}

/**
 * Who works here, what each person may do, and the roles that say so.
 *
 * A role is a name and the permissions ticked for it. The four roles the
 * system started with are built in and fixed; anyone who manages staff can
 * add their own, but never with a permission they do not hold themselves -
 * the database refuses that, and the boxes for it are greyed out here.
 *
 * Creating a login stays a Supabase dashboard action, deliberately - see B4 in
 * getting-started.md. A new account shows up here on its own, inactive.
 */
export function Staff() {
  const { t, locale } = useLocale();
  const { data: identity } = useGetIdentity<StaffIdentity>();

  const [rows, setRows] = useState<StaffRow[] | null>(null);
  const [roles, setRoles] = useState<RoleRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<StaffRow | null>(null);
  const [editingRole, setEditingRole] = useState<RoleRow | 'new' | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);

    void Promise.all([
      supabase.rpc('staff_directory'),
      supabase.from('roles').select('id, builtin_role, name_ar, permissions').order('created_at'),
    ]).then(([staffResult, roleResult]) => {
      if (cancelled) return;
      if (staffResult.error || roleResult.error) {
        setError(arabicError(staffResult.error ?? roleResult.error));
        return;
      }
      // Pending accounts are the reason this screen exists, so they lead.
      const sorted = [...((staffResult.data ?? []) as StaffRow[])].sort((a, b) => {
        if (a.is_active !== b.is_active) return a.is_active ? 1 : -1;
        return a.full_name.localeCompare(b.full_name);
      });
      setRows(sorted);
      setRoles((roleResult.data ?? []) as RoleRow[]);
    });

    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  const roleById = useMemo(() => new Map((roles ?? []).map((role) => [role.id, role])), [roles]);
  const reload = () => setReloadToken((token) => token + 1);

  return (
    <div className="space-y-6">
      <section className="space-y-4">
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
              <thead className="border-b border-duch-line bg-stone-50 text-xs text-stone-500">
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
                        {row.is_owner ? (
                          <span className="ms-2">
                            <Badge tone="good">{t('staff.owner')}</Badge>
                          </span>
                        ) : null}
                      </span>
                      {row.phone ? <span className="text-xs text-stone-500">{row.phone}</span> : null}
                    </td>
                    <td className="px-4 py-3 text-stone-600" dir="ltr">
                      {row.email}
                    </td>
                    <td className="px-4 py-3">{row.role_id ? (roleById.get(row.role_id)?.name_ar ?? '—') : '—'}</td>
                    <td className="px-4 py-3">
                      <Badge tone={row.is_active ? 'good' : 'warn'}>
                        {row.is_active ? t('staff.active') : t('staff.pending')}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-end">
                      <Button variant="secondary" className="min-h-9 text-xs" onClick={() => setEditing(row)}>
                        {t('staff.edit')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-base font-extrabold">{t('staff.roles')}</h2>
          <Button className="ms-auto" onClick={() => setEditingRole('new')}>
            {t('staff.newRole')}
          </Button>
        </div>

        {!roles ? null : (
          <div className="grid gap-3 sm:grid-cols-2">
            {roles.map((role) => {
              const holders = (rows ?? []).filter((row) => row.role_id === role.id).length;
              return (
                <Card key={role.id} className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-bold">
                      <bdi>{role.name_ar}</bdi>
                    </span>
                    {role.builtin_role ? <Badge>{t('staff.builtIn')}</Badge> : null}
                    <span className="text-xs text-stone-500">{t('staff.holders', { count: holders })}</span>
                    {!role.builtin_role ? (
                      <Button
                        variant="secondary"
                        className="ms-auto min-h-8 px-3 text-xs"
                        onClick={() => setEditingRole(role)}
                      >
                        {t('staff.edit')}
                      </Button>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {role.permissions.map((permission) => (
                      <span key={permission} className="rounded-md bg-stone-100 px-2 py-0.5 text-xs text-stone-700">
                        {permissionLabel(permission, t)}
                      </span>
                    ))}
                    {role.permissions.length === 0 ? (
                      <span className="text-xs text-stone-500">{t('staff.noPermissions')}</span>
                    ) : null}
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      <EditDialog
        row={editing}
        roles={roles ?? []}
        locale={locale}
        myPermissions={identity?.permissions ?? []}
        onClose={() => setEditing(null)}
        onDone={() => {
          setEditing(null);
          reload();
        }}
      />

      {editingRole ? (
        <RoleDialog
          role={editingRole === 'new' ? null : editingRole}
          holders={
            editingRole === 'new' ? 0 : (rows ?? []).filter((row) => row.role_id === editingRole.id).length
          }
          myPermissions={identity?.permissions ?? []}
          onClose={() => setEditingRole(null)}
          onDone={() => {
            setEditingRole(null);
            reload();
          }}
        />
      ) : null}
    </div>
  );
}

/** Whether every permission of a role is one this person holds - the rule the database applies. */
function mayGive(role: RoleRow, mine: readonly string[]): boolean {
  if (mine.includes('*')) return true;
  return role.permissions.every((permission) => permission !== '*' && mine.includes(permission));
}

function EditDialog({
  row,
  roles,
  locale,
  myPermissions,
  onClose,
  onDone,
}: {
  row: StaffRow | null;
  roles: RoleRow[];
  locale: 'ar' | 'en';
  myPermissions: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useLocale();
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [roleId, setRoleId] = useState('');
  const [isActive, setIsActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!row) return;
    setFullName(row.full_name);
    setPhone(row.phone ?? '');
    setRoleId(row.role_id ?? '');
    setIsActive(row.is_active);
    setError(null);
  }, [row]);

  if (!row) return null;

  // Captured so the null check above still holds inside submit() - see the
  // same note in Stock.tsx's AdjustDialog.
  const target = row;

  async function submit() {
    if (!roleId) {
      setError(t('staff.pickRole'));
      return;
    }

    setSaving(true);
    setError(null);

    const { error: updateError } = await supabase
      .from('staff')
      .update({
        full_name: fullName.trim() || target.full_name,
        phone: phone.trim() || null,
        role_id: roleId,
        is_active: isActive,
      })
      .eq('id', target.id);

    setSaving(false);

    if (updateError) {
      setError(arabicError(updateError));
      return;
    }

    onDone();
  }

  return (
    <Modal open title={t('staff.editTitle', { name: row.full_name })} onClose={onClose}>
      <div className="space-y-3">
        {!row.is_active ? (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">{t('staff.activateAndSetRole')}</p>
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
          <Select value={roleId} onChange={(event) => setRoleId(event.target.value)}>
            <option value="" disabled>
              {t('staff.pickRole')}
            </option>
            {roles.map((role) => (
              <option key={role.id} value={role.id} disabled={!mayGive(role, myPermissions)}>
                {role.name_ar}
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

/** The permissions grouped the way the screens are, so ticking them reads like the menu. */
const PERMISSION_GROUPS: Array<{ key: string; permissions: Permission[] }> = [
  { key: 'sales', permissions: ['sales.create'] },
  { key: 'orders', permissions: ['orders.read', 'orders.settle', 'orders.edit', 'orders.cancel'] },
  { key: 'shipping', permissions: ['orders.ship', 'returns.manage'] },
  { key: 'stock', permissions: ['stock.read', 'stock.adjust', 'products.manage'] },
  { key: 'admin', permissions: ['reports.read', 'settlements.manage', 'sync.manage', 'staff.manage'] },
];

function RoleDialog({
  role,
  holders,
  myPermissions,
  onClose,
  onDone,
}: {
  role: RoleRow | null;
  holders: number;
  myPermissions: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useLocale();
  const [name, setName] = useState(role?.name_ar ?? '');
  const [picked, setPicked] = useState<Set<string>>(new Set(role?.permissions ?? []));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Every permission is listed so none is forgotten when this list grows.
  const grouped = new Set(PERMISSION_GROUPS.flatMap((group) => group.permissions));
  const missing = PERMISSIONS.filter((permission) => !grouped.has(permission));

  function toggle(permission: string) {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(permission)) next.delete(permission);
      else next.add(permission);
      return next;
    });
  }

  async function save() {
    if (!name.trim()) {
      setError(t('staff.roleNameNeeded'));
      return;
    }
    setBusy(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc('save_role', {
      p_role_id: role?.id ?? null,
      p_name_ar: name.trim(),
      p_permissions: [...picked],
    });
    setBusy(false);
    if (rpcError) {
      setError(arabicError(rpcError));
      return;
    }
    onDone();
  }

  async function remove() {
    if (!role) return;
    setBusy(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc('delete_role', { p_role_id: role.id });
    setBusy(false);
    if (rpcError) {
      setError(arabicError(rpcError));
      return;
    }
    onDone();
  }

  return (
    <Modal open title={role ? t('staff.editRole') : t('staff.newRole')} onClose={onClose}>
      <div className="space-y-4">
        <Field label={t('staff.roleName')}>
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder={t('staff.roleNameHint')} />
        </Field>

        {[...PERMISSION_GROUPS, ...(missing.length ? [{ key: 'other', permissions: missing }] : [])].map((group) => (
          <fieldset key={group.key} className="space-y-1.5">
            <legend className="mb-1 text-xs font-bold text-stone-500">{t(`staff.group.${group.key}`)}</legend>
            {group.permissions.map((permission) => {
              const allowed = can(myPermissions, permission);
              return (
                <label
                  key={permission}
                  className={cx(
                    'flex items-center gap-2 rounded-lg border px-3 py-2 text-sm',
                    picked.has(permission) ? 'border-duch-ink' : 'border-duch-line',
                    !allowed && 'opacity-50',
                  )}
                >
                  <input
                    type="checkbox"
                    checked={picked.has(permission)}
                    disabled={!allowed}
                    onChange={() => toggle(permission)}
                    className="size-4 accent-duch-ink"
                  />
                  {permissionLabel(permission, t)}
                </label>
              );
            })}
          </fieldset>
        ))}

        {error ? <ErrorNote>{error}</ErrorNote> : null}

        <div className="flex flex-wrap gap-2 pt-1">
          <Button className="flex-1" onClick={save} disabled={busy}>
            {busy ? t('app.loading') : t('app.save')}
          </Button>
          {role ? (
            <Button
              variant="secondary"
              onClick={remove}
              disabled={busy || holders > 0}
              title={holders > 0 ? t('staff.roleInUse', { count: holders }) : undefined}
            >
              {t('staff.deleteRole')}
            </Button>
          ) : null}
          <Button variant="secondary" onClick={onClose}>
            {t('app.cancel')}
          </Button>
        </div>
        {role && holders > 0 ? (
          <p className="text-xs text-stone-500">{t('staff.roleInUse', { count: holders })}</p>
        ) : null}
      </div>
    </Modal>
  );
}
