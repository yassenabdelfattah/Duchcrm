/**
 * Domain vocabulary shared by the dashboard, the Edge Functions and the Worker.
 *
 * These values are mirrored by Postgres enums in supabase/migrations. If you
 * change one here you must change it there too - `npm run db:test` has a check
 * that fails when they drift apart.
 */

export const STAFF_ROLES = ['admin', 'stock_manager', 'sales', 'packing'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const STOCK_MOVEMENT_REASONS = [
  'online_order',
  'store_sale',
  'wholesale',
  'production_in',
  'return',
  'cancellation',
  'adjustment',
  'initial_import',
  'stock_out',
  'stock_out_return',
] as const;
export type StockMovementReason = (typeof STOCK_MOVEMENT_REASONS)[number];

/**
 * Reasons where the CRM is the gatekeeper: we decide whether the sale happens,
 * so we refuse to let stock go negative. The database enforces this too.
 */
export const BLOCKING_REASONS: readonly StockMovementReason[] = ['store_sale', 'wholesale', 'stock_out'];

/**
 * Reasons that record something which already happened elsewhere. Refusing
 * these would mean losing the record, so they are allowed to drive stock
 * negative - the nightly reconciler surfaces the result as a sync issue.
 */
export const RECORDING_REASONS: readonly StockMovementReason[] = [
  'online_order',
  'cancellation',
  'return',
  'production_in',
  'adjustment',
  'initial_import',
];

export const SALES_CHANNELS = ['store', 'online', 'dm', 'wholesale'] as const;
export type SalesChannel = (typeof SALES_CHANNELS)[number];

/**
 * `deferred` is a tab: the goods go now and the money is owed. It is the one
 * method here that does not mean the money has arrived, other than `cod`,
 * where the courier is holding it.
 */
export const PAYMENT_METHODS = [
  'cash',
  'card',
  'instapay',
  'cod',
  'bank_transfer',
  'deferred',
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const ORDER_STATUSES = ['draft', 'confirmed', 'completed', 'cancelled', 'refunded'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const SYNC_ISSUE_TYPES = [
  'quantity_mismatch',
  'missing_in_shopify',
  'missing_in_crm',
  'push_failed',
  'unmapped_inventory_item',
] as const;
export type SyncIssueType = (typeof SYNC_ISSUE_TYPES)[number];

export const SYNC_ISSUE_STATUSES = ['open', 'acknowledged', 'resolved', 'ignored'] as const;
export type SyncIssueStatus = (typeof SYNC_ISSUE_STATUSES)[number];

/**
 * Shopify webhook topics we subscribe to. Phase 2 only needs the inventory
 * one; the order topics are wired up in Phase 3 but registered here so the
 * webhook router can acknowledge them instead of 404-ing.
 */
export const SHOPIFY_WEBHOOK_TOPICS = [
  'inventory_levels/update',
  'orders/create',
  'orders/updated',
  'orders/cancelled',
  'refunds/create',
  'products/update',
] as const;
export type ShopifyWebhookTopic = (typeof SHOPIFY_WEBHOOK_TOPICS)[number];

/**
 * Every permission a role can be given - the same list as the database's
 * known_permissions(). A role is a name and some of these; the built-in admin
 * role holds "*", everything. The database enforces each one; the dashboard
 * only uses them to decide what to show.
 */
export const PERMISSIONS = [
  'sales.create',
  'orders.read',
  'orders.settle',
  'orders.edit',
  'orders.cancel',
  'orders.ship',
  'returns.manage',
  'stock.read',
  'stock.adjust',
  'products.manage',
  'reports.read',
  'settlements.manage',
  'sync.manage',
  'staff.manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Whether a set of permissions includes this one. */
export function can(permissions: readonly string[] | null | undefined, permission: Permission): boolean {
  if (!permissions) return false;
  return permissions.includes('*') || permissions.includes(permission);
}

/** Whether a set of permissions includes any of these. */
export function canAny(permissions: readonly string[] | null | undefined, wanted: readonly Permission[]): boolean {
  return wanted.some((permission) => can(permissions, permission));
}
