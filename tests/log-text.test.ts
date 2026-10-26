import { describe, expect, it } from 'vitest';
import ar from '../apps/dashboard/src/i18n/ar.json';
import { logNote, logTitle, type LogRow } from '../apps/dashboard/src/lib/logText';

// The Arabic the log is read in, with {{params}} filled the way the app does.
const t = (key: string, params?: Record<string, unknown>) => {
  const text = key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], ar);
  if (typeof text !== 'string') return key;
  return text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(params?.[name] ?? ''));
};

const row = (fields: Partial<LogRow>): LogRow => ({
  kind: 'stock',
  id: '1',
  created_at: '2026-10-26T10:00:00Z',
  activity_date: '2026-10-26',
  staff_name: null,
  action: 'adjustment',
  event_type: null,
  from_status: null,
  quantity_delta: -1,
  variant_id: null,
  sku: null,
  product_title: null,
  variant_label: null,
  location_name: null,
  note: null,
  reference_type: null,
  order_id: null,
  order_number: null,
  order_channel: null,
  customer_name: null,
  taken_by: null,
  taken_out_reason: null,
  taken_out_reason_text: null,
  taken_out_note: null,
  ...fields,
});

describe('logTitle', () => {
  it('says what an adjustment was for, not just that it was one', () => {
    expect(logTitle(row({ reference_type: 'order' }), t)).toBe('تعديل منتجات الطلب');
    expect(logTitle(row({ reference_type: 'sync_issue' }), t)).toBe('تصحيح العدد من شوبيفاي');
    expect(logTitle(row({ reference_type: 'stock_count' }), t)).toBe('جرد');
    expect(logTitle(row({ reference_type: 'manual_adjustment' }), t)).toBe('تعديل يدوي');
  });

  it('says where a sale happened', () => {
    expect(logTitle(row({ action: 'store_sale', order_channel: 'store' }), t)).toBe('بيع في المحل');
    expect(logTitle(row({ action: 'store_sale', order_channel: 'dm' }), t)).toBe('بيع سوشيال ميديا');
    expect(logTitle(row({ action: 'online_order' }), t)).toBe('بيع على الموقع');
  });

  it('says why a piece was taken out, in the words typed when it was none of the listed reasons', () => {
    expect(logTitle(row({ action: 'stock_out', reference_type: 'stock_out', taken_out_reason: 'photoshoot' }), t)).toBe(
      'خرجت من المخزن · تصوير',
    );
    expect(
      logTitle(
        row({ action: 'stock_out', reference_type: 'stock_out', taken_out_reason: 'other', taken_out_reason_text: 'معرض' }),
        t,
      ),
    ).toBe('خرجت من المخزن · معرض');
    expect(logTitle(row({ action: 'stock_out_return', taken_out_reason: 'photoshoot' }), t)).toBe('رجعت من تصوير');
  });

  it('names an order change by what changed', () => {
    const order = { kind: 'order' as const, quantity_delta: null };
    expect(logTitle(row({ ...order, event_type: 'created', action: 'awaiting_confirmation' }), t)).toBe('طلب جديد');
    expect(logTitle(row({ ...order, event_type: 'payment_change', action: 'paid' }), t)).toBe('الدفع: مدفوع');
    expect(logTitle(row({ ...order, event_type: 'fulfillment_change', action: 'delivered' }), t)).toBe(
      t('fulfillment.delivered'),
    );
  });
});

describe('logNote', () => {
  it('keeps what a person wrote', () => {
    expect(logNote(row({ reference_type: 'stock_count', note: 'خرج مع يوسف' }), t)).toBe('خرج مع يوسف');
  });

  it('translates what Shopify and the system wrote, and drops what the title already says', () => {
    expect(logNote(row({ action: 'cancellation', note: 'customer' }), t)).toBe('بطلب العميل');
    expect(logNote(row({ kind: 'order', note: 'Order from before the CRM' }), t)).toBe('طلب من قبل النظام');
    expect(logNote(row({ reference_type: 'order', note: 'Order #1470 edited' }), t)).toBeNull();
    expect(logNote(row({ reference_type: 'sync_issue', note: 'Accepted the Shopify count at reconciliation' }), t)).toBeNull();
  });

  it('shows the note written on a taking-out, not the line the system composed from it', () => {
    expect(
      logNote(row({ reference_type: 'stock_out', note: 'damaged · المصنع · تصليح', taken_out_note: 'تصليح' }), t),
    ).toBe('تصليح');
    expect(logNote(row({ reference_type: 'stock_out', note: 'photoshoot · joe' }), t)).toBeNull();
  });
});
