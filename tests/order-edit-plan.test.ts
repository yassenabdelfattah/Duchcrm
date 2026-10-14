import { describe, expect, it } from 'vitest';
import { planOrderEdit, type ShopifyEditLine } from '../supabase/functions/_shared/order-edit-plan';

const line = (id: string, variantId: number | null, sku: string, quantity: number, editable = quantity): ShopifyEditLine => ({
  id: `gid://shopify/CalculatedLineItem/${id}`,
  variantId,
  sku,
  quantity,
  editableQuantity: editable,
});

describe('planOrderEdit', () => {
  it('does nothing when Shopify already matches - a job that runs twice changes nothing the second time', () => {
    const plan = planOrderEdit(
      [line('1', 101, 'A', 1), line('2', 102, 'B', 2)],
      [
        { shopifyVariantId: 102, sku: 'B', quantity: 2 },
        { shopifyVariantId: 101, sku: 'A', quantity: 1 },
      ],
    );
    expect(plan).toEqual({ steps: [], problems: [] });
  });

  it('removes an item by setting its line to zero', () => {
    const plan = planOrderEdit(
      [line('1', 101, 'A', 1), line('2', 102, 'B', 1)],
      [{ shopifyVariantId: 101, sku: 'A', quantity: 1 }],
    );
    expect(plan.steps).toEqual([
      { kind: 'setQuantity', lineItemId: 'gid://shopify/CalculatedLineItem/2', quantity: 0 },
    ]);
  });

  it('adds a new variant, and raises the quantity of one already there', () => {
    const plan = planOrderEdit(
      [line('1', 101, 'A', 1)],
      [
        { shopifyVariantId: 101, sku: 'A', quantity: 3 },
        { shopifyVariantId: 103, sku: 'C', quantity: 2 },
      ],
    );
    expect(plan.steps).toEqual([
      { kind: 'setQuantity', lineItemId: 'gid://shopify/CalculatedLineItem/1', quantity: 3 },
      { kind: 'addVariant', variantId: 103, quantity: 2, allowDuplicates: false },
    ]);
  });

  it('swaps a size: one down to zero, the other added', () => {
    const plan = planOrderEdit(
      [line('1', 201, 'TEE-M', 1)],
      [{ shopifyVariantId: 202, sku: 'TEE-L', quantity: 1 }],
    );
    expect(plan.steps).toEqual([
      { kind: 'setQuantity', lineItemId: 'gid://shopify/CalculatedLineItem/1', quantity: 0 },
      { kind: 'addVariant', variantId: 202, quantity: 1, allowDuplicates: false },
    ]);
  });

  it('adds back an item removed by an earlier edit as a new line, since its old one is closed', () => {
    const plan = planOrderEdit(
      [line('1', 101, 'A', 0, 0), line('2', 102, 'B', 1)],
      [
        { shopifyVariantId: 101, sku: 'A', quantity: 1 },
        { shopifyVariantId: 102, sku: 'B', quantity: 1 },
      ],
    );
    expect(plan.steps).toEqual([{ kind: 'addVariant', variantId: 101, quantity: 1, allowDuplicates: true }]);
  });

  it('never takes a line below what was fulfilled in Shopify', () => {
    const plan = planOrderEdit([line('1', 101, 'A', 2, 1)], []);
    expect(plan.steps).toEqual([]);
    expect(plan.problems[0]).toMatch(/already fulfilled/);
  });

  it('refuses to add an item that has no Shopify variant', () => {
    const plan = planOrderEdit([], [{ shopifyVariantId: null, sku: 'LOCAL-ONLY', quantity: 1 }]);
    expect(plan.problems[0]).toMatch(/LOCAL-ONLY/);
  });

  it('leaves the shipping alone when the amount already matches', () => {
    const plan = planOrderEdit([], [], {
      current: [{ id: 's1', amount: 70, stagedStatus: 'NONE' }],
      target: 70,
    });
    expect(plan.steps).toEqual([]);
  });

  it('replaces the shipping line when the fee changed', () => {
    const plan = planOrderEdit([], [], {
      current: [{ id: 's1', amount: 70, stagedStatus: 'NONE' }],
      target: 90,
    });
    expect(plan.steps).toEqual([
      { kind: 'removeShipping', shippingLineId: 's1' },
      { kind: 'addShipping', amount: 90 },
    ]);
  });

  it('removes the shipping without adding a zero line when it becomes free', () => {
    const plan = planOrderEdit([], [], {
      current: [{ id: 's1', amount: 70, stagedStatus: 'NONE' }],
      target: 0,
    });
    expect(plan.steps).toEqual([{ kind: 'removeShipping', shippingLineId: 's1' }]);
  });
});
