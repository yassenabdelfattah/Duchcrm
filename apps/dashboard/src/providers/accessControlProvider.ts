import type { AccessControlProvider } from '@refinedev/core';
import { can, type StaffRole } from '@duch/shared';
import { authProvider } from './authProvider';

/**
 * Decides which navigation items and buttons a role sees.
 *
 * This is presentation only. Every rule here is also enforced by Row Level
 * Security and by the guard clauses inside the stock RPCs, because hiding a
 * button stops an honest mistake but not a crafted request. If you ever find a
 * rule that exists only here, that is a bug in the database, not a feature of
 * the UI.
 */
const RESOURCE_CAPABILITY: Record<string, Record<string, string>> = {
  products: { list: 'products.read', show: 'products.read', edit: 'products.write', create: 'products.write' },
  variants: { list: 'products.read', show: 'products.read', edit: 'products.write' },
  stock: { list: 'stock.read', show: 'stock.read', adjust: 'stock.adjust' },
  sale: { create: 'sales.create', list: 'sales.read' },
  orders: { list: 'sales.read', show: 'sales.read', create: 'sales.create' },
  customers: { list: 'sales.read', edit: 'customers.write', create: 'customers.write' },
  sync_issues: { list: 'sync.read', show: 'sync.read', edit: 'sync.resolve' },
  staff: { list: 'staff.read', edit: 'staff.write' },
};

export const accessControlProvider: AccessControlProvider = {
  async can({ resource, action }) {
    const role = (await authProvider.getPermissions?.()) as StaffRole | null;

    if (!role) {
      return { can: false, reason: 'auth.pendingTitle' };
    }

    const capability = resource ? RESOURCE_CAPABILITY[resource]?.[action] : undefined;

    // An action nobody has explicitly described is allowed for admins only,
    // so a forgotten entry fails closed rather than open.
    if (!capability) {
      return { can: role === 'admin', reason: 'auth.noAccess' };
    }

    return can(role, capability)
      ? { can: true }
      : { can: false, reason: 'auth.noAccess' };
  },
  options: {
    buttons: { enableAccessControl: true, hideIfUnauthorized: true },
  },
};
