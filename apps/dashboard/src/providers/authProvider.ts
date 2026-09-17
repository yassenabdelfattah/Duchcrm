import type { AuthProvider } from '@refinedev/core';
import type { StaffRole } from '@duch/shared';
import { supabase } from '../lib/supabase';

export interface StaffIdentity {
  id: string;
  email: string | null;
  full_name: string;
  role: StaffRole | null;
  is_active: boolean;
}

/**
 * Reads the signed-in person's staff record.
 *
 * The JWT also carries a staff_role claim, but that is only a hint for
 * rendering the sidebar quickly. This query is the one the app trusts, and it
 * is the same source the database policies read - so what the interface offers
 * and what the database permits cannot drift apart.
 */
async function fetchIdentity(): Promise<StaffIdentity | null> {
  const { data: session } = await supabase.auth.getSession();
  const user = session.session?.user;
  if (!user) return null;

  const { data, error } = await supabase
    .from('staff')
    .select('id, full_name, role, is_active')
    .eq('id', user.id)
    .maybeSingle();

  if (error || !data) {
    // A signed-in user with no staff row: the signup trigger should prevent
    // this, but treating it as "pending approval" is the safe reading.
    return {
      id: user.id,
      email: user.email ?? null,
      full_name: user.email ?? '',
      role: null,
      is_active: false,
    };
  }

  return {
    id: data.id as string,
    email: user.email ?? null,
    full_name: data.full_name as string,
    role: (data.role as StaffRole | null) ?? null,
    is_active: Boolean(data.is_active),
  };
}

export const authProvider: AuthProvider = {
  async login({ email, password }: { email: string; password: string }) {
    const { error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      return {
        success: false,
        error: { name: 'auth.invalid', message: 'auth.invalid' },
      };
    }

    return { success: true, redirectTo: '/' };
  },

  async logout() {
    await supabase.auth.signOut();
    return { success: true, redirectTo: '/login' };
  },

  async check() {
    const { data } = await supabase.auth.getSession();
    if (!data.session) {
      return { authenticated: false, redirectTo: '/login' };
    }

    // Whether the account has been activated is decided by <ActiveStaffGate>
    // rather than here, so there is exactly one place that sends someone to
    // the pending screen.
    return { authenticated: true };
  },

  async onError(error) {
    // 401/403 from PostgREST means the session expired or the account was
    // deactivated mid-session. Either way, back to the login screen.
    const status = (error as { status?: number; statusCode?: number })?.status ??
      (error as { statusCode?: number })?.statusCode;

    if (status === 401) {
      return { logout: true, redirectTo: '/login', error };
    }
    return { error };
  },

  getIdentity: fetchIdentity,

  async getPermissions() {
    const identity = await fetchIdentity();
    return identity?.role ?? null;
  },
};
