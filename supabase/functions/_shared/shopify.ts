import { config } from './env.ts';

/**
 * Minimal Shopify GraphQL Admin API client.
 *
 * Deliberately not a generated SDK: the surface we use is small, and pinning
 * the version and the retry behaviour in one readable file is worth more here
 * than type generation would be.
 */

export interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
  extensions?: {
    cost?: {
      requestedQueryCost: number;
      actualQueryCost: number;
      throttleStatus: {
        maximumAvailable: number;
        currentlyAvailable: number;
        restoreRate: number;
      };
    };
  };
}

export class ShopifyError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'ShopifyError';
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function shopifyGraphQL<T>(
  query: string,
  variables: Record<string, unknown> = {},
  options: { maxAttempts?: number } = {},
): Promise<GraphQLResponse<T>> {
  const maxAttempts = options.maxAttempts ?? 4;
  const url = `https://${config.shopifyDomain}/admin/api/${config.shopifyApiVersion}/graphql.json`;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': config.shopifyToken,
      },
      body: JSON.stringify({ query, variables }),
    });

    // Shopify's GraphQL endpoint answers 200 for most application errors, so
    // a non-200 here means rate limiting or something genuinely broken.
    if (response.status === 429 || response.status >= 500) {
      const retryAfter = Number(response.headers.get('retry-after') ?? '0');
      const backoffMs = retryAfter > 0 ? retryAfter * 1000 : Math.min(2 ** attempt * 500, 8000);
      lastError = new ShopifyError(
        `Shopify returned ${response.status}`,
        response.status,
        await response.text().catch(() => null),
      );
      if (attempt < maxAttempts) {
        await sleep(backoffMs);
        continue;
      }
      throw lastError;
    }

    if (!response.ok) {
      throw new ShopifyError(
        `Shopify returned ${response.status}`,
        response.status,
        await response.text().catch(() => null),
      );
    }

    const body = (await response.json()) as GraphQLResponse<T>;

    // The cost-based limiter reports THROTTLED inside a 200 response.
    const throttled = body.errors?.some(
      (e) => (e.extensions as { code?: string } | undefined)?.code === 'THROTTLED',
    );
    if (throttled && attempt < maxAttempts) {
      const available = body.extensions?.cost?.throttleStatus.currentlyAvailable ?? 0;
      const restoreRate = body.extensions?.cost?.throttleStatus.restoreRate ?? 50;
      const needed = Math.max(0, (body.extensions?.cost?.requestedQueryCost ?? 100) - available);
      await sleep(Math.min(((needed / restoreRate) * 1000) + 250, 8000));
      continue;
    }

    return body;
  }

  throw lastError ?? new Error('Shopify request failed after retries');
}

// --- GID helpers -----------------------------------------------------------

export const gid = {
  inventoryItem: (id: number | string) => `gid://shopify/InventoryItem/${id}`,
  location: (id: number | string) => `gid://shopify/Location/${id}`,
  product: (id: number | string) => `gid://shopify/Product/${id}`,
  variant: (id: number | string) => `gid://shopify/ProductVariant/${id}`,
};

/** `gid://shopify/InventoryItem/12345` -> `12345` */
export function parseGid(value: string | null | undefined): number | null {
  if (!value) return null;
  const last = value.split('/').pop();
  const parsed = Number(last);
  return Number.isFinite(parsed) ? parsed : null;
}

// --- Inventory -------------------------------------------------------------

/**
 * Note the @idempotent directive. Shopify has required it on inventory
 * mutations since API version 2026-04: without it the call fails at runtime
 * even though the schema does not mark it as required. Passing the push row's
 * key means a retry after a timeout cannot apply the same change twice.
 *
 * compareQuantity is Shopify's optimistic lock. If the storefront sold a unit
 * between us reading and us writing, the mutation fails rather than silently
 * overwriting that sale, and we re-read and try again.
 */
const SET_INVENTORY_MUTATION = /* GraphQL */ `
  mutation DuchSetInventory($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
    inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
      inventoryAdjustmentGroup {
        createdAt
        reason
        referenceDocumentUri
        changes {
          name
          delta
          quantityAfterChange
        }
      }
      userErrors {
        code
        field
        message
      }
    }
  }
`;

export interface SetInventoryArgs {
  inventoryItemId: number;
  locationId: number;
  quantity: number;
  /** Omit to skip the optimistic lock (only safe for a first-time import). */
  compareQuantity?: number | null;
  idempotencyKey: string;
  referenceDocumentUri?: string;
  /** Which Shopify quantity state to write. See DECISIONS.md #1. */
  name?: 'available' | 'on_hand';
}

export interface SetInventoryResult {
  ok: boolean;
  userErrors: Array<{ code?: string; field?: string[]; message: string }>;
  raw: unknown;
}

export async function setInventoryQuantity(args: SetInventoryArgs): Promise<SetInventoryResult> {
  const quantity: Record<string, unknown> = {
    inventoryItemId: gid.inventoryItem(args.inventoryItemId),
    locationId: gid.location(args.locationId),
    quantity: args.quantity,
  };

  const useCompare = typeof args.compareQuantity === 'number';
  if (useCompare) {
    quantity.compareQuantity = args.compareQuantity;
  }

  const body = await shopifyGraphQL<{
    inventorySetQuantities: {
      inventoryAdjustmentGroup: unknown;
      userErrors: Array<{ code?: string; field?: string[]; message: string }>;
    };
  }>(SET_INVENTORY_MUTATION, {
    idempotencyKey: args.idempotencyKey,
    input: {
      name: args.name ?? 'available',
      reason: 'correction',
      referenceDocumentUri: args.referenceDocumentUri ?? 'https://duch.store/crm',
      ignoreCompareQuantity: !useCompare,
      quantities: [quantity],
    },
  });

  if (body.errors?.length) {
    return {
      ok: false,
      userErrors: body.errors.map((e) => ({ message: e.message })),
      raw: body,
    };
  }

  const userErrors = body.data?.inventorySetQuantities?.userErrors ?? [];
  return { ok: userErrors.length === 0, userErrors, raw: body };
}

// --- Reading inventory (for the nightly reconciliation) --------------------

const INVENTORY_LEVELS_QUERY = /* GraphQL */ `
  query DuchInventoryLevels($locationId: ID!, $cursor: String) {
    location(id: $locationId) {
      id
      inventoryLevels(first: 100, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          item {
            id
            sku
          }
          quantities(names: ["available", "on_hand", "committed"]) {
            name
            quantity
          }
        }
      }
    }
  }
`;

export interface InventoryLevelRow {
  inventory_item_id: number;
  location_id: number;
  sku: string | null;
  available: number;
  on_hand: number;
  committed: number;
}

/**
 * The shape of one page, named rather than written inline at the call site.
 *
 * Inlining it there creates a circular inference that TypeScript resolves by
 * making the response `any`: `cursor` is assigned from the response at the
 * bottom of the loop, and the response's type depends on `cursor` being passed
 * in at the top. The result compiles but type-checks nothing inside the loop.
 */
interface InventoryLevelsPage {
  location: {
    inventoryLevels: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: Array<{
        item: { id: string; sku: string | null };
        quantities: Array<{ name: string; quantity: number }>;
      }>;
    };
  } | null;
}

/** Walks every page of inventory levels at a location. */
export async function fetchAllInventoryLevels(locationId: number): Promise<InventoryLevelRow[]> {
  const rows: InventoryLevelRow[] = [];
  let cursor: string | null = null;

  do {
    // Annotated explicitly, which is what breaks the cycle described above.
    const body: GraphQLResponse<InventoryLevelsPage> =
      await shopifyGraphQL<InventoryLevelsPage>(
        INVENTORY_LEVELS_QUERY,
        { locationId: gid.location(locationId), cursor },
      );

    if (body.errors?.length) {
      throw new ShopifyError(
        `Failed to read inventory levels: ${body.errors.map((e) => e.message).join('; ')}`,
        200,
        body,
      );
    }

    const levels = body.data?.location?.inventoryLevels;
    if (!levels) break;

    for (const node of levels.nodes) {
      const byName = new Map<string, number>(
        node.quantities.map((q) => [q.name, q.quantity] as [string, number]),
      );
      const itemId = parseGid(node.item.id);
      if (itemId === null) continue;
      rows.push({
        inventory_item_id: itemId,
        location_id: locationId,
        sku: node.item.sku,
        available: byName.get('available') ?? 0,
        on_hand: byName.get('on_hand') ?? 0,
        committed: byName.get('committed') ?? 0,
      });
    }

    cursor = levels.pageInfo.hasNextPage ? levels.pageInfo.endCursor : null;
  } while (cursor);

  return rows;
}

// --- Products --------------------------------------------------------------

export const PRODUCTS_QUERY = /* GraphQL */ `
  query DuchProducts($cursor: String) {
    products(first: 50, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        title
        handle
        descriptionHtml
        productType
        vendor
        status
        tags
        featuredMedia {
          preview {
            image {
              url
            }
          }
        }
        variants(first: 100) {
          nodes {
            id
            title
            sku
            barcode
            price
            compareAtPrice
            position
            selectedOptions {
              name
              value
            }
            inventoryItem {
              id
              tracked
              measurement {
                weight {
                  value
                  unit
                }
              }
            }
          }
        }
      }
    }
  }
`;
