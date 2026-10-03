import type { AccessControlProvider } from '@refinedev/core';
import { can, type Permission } from '@duch/shared';
import { authProvider } from './authProvider';

/**
 * Decides which navigation items and buttons someone sees.
 *
 * This is presentation only. Every rule here is also enforced by Row Level
 * Security and by the guard clauses inside the database functions, because
 * hiding a button stops an honest mistake but not a crafted request. If you
 * ever find a rule that exists only here, that is a bug in the database, not
 * a feature of the UI.
 */
const RESOURCE_PERMISSION: Record<string, Record<string, Permission>> = {
  products: { list: 'stock.read', show: 'stock.read', edit: 'products.manage', create: 'products.manage' },
  variants: { list: 'stock.read', show: 'stock.read', edit: 'products.manage' },
  stock: { list: 'stock.read', show: 'stock.read', adjust: 'stock.adjust' },
  sale: { create: 'sales.create', list: 'orders.read' },
  orders: { list: 'orders.read', show: 'orders.read', create: 'sales.create' },
  customers: { list: 'orders.read', edit: 'sales.create', create: 'sales.create' },
  sync_issues: { list: 'sync.manage', show: 'sync.manage', edit: 'sync.manage' },
  staff: { list: 'staff.manage', edit: 'staff.manage' },
};

export const accessControlProvider: AccessControlProvider = {
  async can({ resource, action }) {
    const permissions = (await authProvider.getPermissions?.()) as string[] | null;

    if (!permissions) {
      return { can: false, reason: 'auth.pendingTitle' };
    }

    const permission = resource ? RESOURCE_PERMISSION[resource]?.[action] : undefined;

    // An action nobody has explicitly described is allowed for admins only,
    // so a forgotten entry fails closed rather than open.
    if (!permission) {
      return { can: permissions.includes('*'), reason: 'auth.noAccess' };
    }

    return can(permissions, permission) ? { can: true } : { can: false, reason: 'auth.noAccess' };
  },
  options: {
    buttons: { enableAccessControl: true, hideIfUnauthorized: true },
  },
};
