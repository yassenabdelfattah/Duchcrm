import { describe, expect, it } from 'vitest';
import ar from '../apps/dashboard/src/i18n/ar.json';
import { accountantMessage, type MessageLine } from '../apps/dashboard/src/lib/accountantMessage';

// The Arabic the message is actually sent in.
const t = (key: string) =>
  key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], ar) as string;

const line = (fields: Partial<MessageLine>): MessageLine => ({
  outcome: 'delivered',
  tracking_number: null,
  order_number: null,
  collected_egp: 0,
  fee_egp: 0,
  net_egp: (fields.collected_egp ?? 0) - (fields.fee_egp ?? 0),
  note: null,
  ...fields,
});

describe('accountantMessage', () => {
  it('lists the products, then what was taken off, their total and what is left', () => {
    const message = accountantMessage(
      [
        { title: 'Brown Baseball Leather Jacket', quantity: 2, total_egp: 1400 },
        { title: 'Leather Hoodie', quantity: 1, total_egp: 550 },
        // The same product at a second price is still one line.
        { title: 'Brown Baseball Leather Jacket', quantity: 1, total_egp: 700 },
      ],
      [
        line({ order_number: '#1407', collected_egp: 1400 }),
        line({ order_number: '#1408', collected_egp: 1250 }),
        line({ outcome: 'returned_other', order_number: '#1413', fee_egp: 130 }),
        line({ order_number: '#1414', fee_egp: 80 }),
        line({ outcome: 'adjustment', note: 'فلايرات', fee_egp: 210 }),
      ],
      t,
    );

    expect(message).toBe(
      [
        'Brown Baseball Leather Jacket * 3 = 2,100',
        '--------------------',
        'Leather Hoodie * 1 = 550',
        '--------------------',
        'اجمالي المنتجات = 2,650',
        '--------------------',
        'خصومات',
        'مرتجعة #1413 = 130',
        'شحن #1414 = 80',
        'فلايرات = 210',
        '--------------------',
        'اجمالي الخصومات = 420',
        '--------------------',
        'صافي التحويل = 2,230',
      ].join('\n'),
    );
  });

  it('adds up even when a parcel was collected for a little less than its goods', () => {
    const message = accountantMessage(
      [{ title: 'Slim Fit T-shirt', quantity: 3, total_egp: 615 }],
      [line({ order_number: '#1415', collected_egp: 605 })],
      t,
    );

    expect(message).toBe(
      [
        'Slim Fit T-shirt * 3 = 615',
        '--------------------',
        'اجمالي المنتجات = 615',
        '--------------------',
        'خصومات',
        'فرق في التحصيل = 10',
        '--------------------',
        'اجمالي الخصومات = 10',
        '--------------------',
        'صافي التحويل = 605',
      ].join('\n'),
    );
  });

  it('tells a discount on the order apart from a difference in what was collected', () => {
    // 615 of shirts, 15 off the order, and Accurate collected 605 - 5 more
    // than the 600 the order came to.
    const message = accountantMessage(
      [{ title: 'Slim Fit T-shirt', quantity: 3, total_egp: 615 }],
      [line({ order_number: '#1415', collected_egp: 605 })],
      t,
      600,
    );

    expect(message).toBe(
      [
        'Slim Fit T-shirt * 3 = 615',
        '--------------------',
        'اجمالي المنتجات = 615',
        '--------------------',
        'خصومات',
        'خصم للعملاء = 15',
        'فرق في التحصيل = -5',
        '--------------------',
        'اجمالي الخصومات = 10',
        '--------------------',
        'صافي التحويل = 605',
      ].join('\n'),
    );
  });

  it('sums what Accurate charged above or below the shipping customers paid into one line', () => {
    // Entered as their statement reads: collected with the shipping, charged
    // their fee. 90 paid and 95 charged; 150 paid and 140 charged.
    const message = accountantMessage(
      [
        { title: 'Two-Strap Slipper', quantity: 1, total_egp: 500 },
        { title: 'Brown Baseball Leather Jacket', quantity: 1, total_egp: 700 },
      ],
      [
        line({ order_number: '#1401', collected_egp: 590, fee_egp: 95, customer_shipping_egp: 90 }),
        line({ order_number: '#1411', collected_egp: 850, fee_egp: 140, customer_shipping_egp: 150 }),
        line({ outcome: 'returned_other', order_number: '#1413', fee_egp: 15, customer_shipping_egp: 110 }),
      ],
      t,
      1200,
    );

    expect(message).toBe(
      [
        'Two-Strap Slipper * 1 = 500',
        '--------------------',
        'Brown Baseball Leather Jacket * 1 = 700',
        '--------------------',
        'اجمالي المنتجات = 1,200',
        '--------------------',
        'خصومات',
        'مرتجعة #1413 = 15',
        'فرق الشحن = -5',
        '--------------------',
        'اجمالي الخصومات = 10',
        '--------------------',
        'صافي التحويل = 1,190',
      ].join('\n'),
    );
  });

  it('names a code the CRM does not know by its code, and has no deductions block without deductions', () => {
    const message = accountantMessage([], [line({ tracking_number: 'N193892', collected_egp: 570 })], t);

    expect(message).toBe(
      ['N193892 = 570', '--------------------', 'اجمالي المنتجات = 570', '--------------------', 'صافي التحويل = 570'].join(
        '\n',
      ),
    );
  });
});
