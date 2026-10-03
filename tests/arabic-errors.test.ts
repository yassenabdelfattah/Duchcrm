import { describe, expect, it } from 'vitest';
import { arabicError } from '../apps/dashboard/src/lib/errors';

describe('arabicError', () => {
  it('translates a known refusal and keeps the order number', () => {
    expect(arabicError({ code: '23514', message: 'Order D2610-00021 is already out (it is in_transit)' })).toBe(
      'الطلب D2610-00021 خرج بالفعل.',
    );
  });

  it('prefers the specific wording over the general one', () => {
    expect(arabicError({ message: 'Order S2609-00015 was returned, so nothing is owed on it' })).toBe(
      'الطلب S2609-00015 مرتجع، فلا يوجد عليه مستحق.',
    );
    expect(arabicError({ message: 'Order X1 was cancelled and cannot be edited' })).toBe(
      'الطلب X1 ملغي ولا يمكن تعديله.',
    );
  });

  it('turns any permission refusal into one sentence', () => {
    expect(arabicError({ code: '42501', message: 'You may not ship orders' })).toBe('ليس لديك صلاحية لهذا الإجراء.');
    expect(arabicError({ code: '42501', message: 'something new' })).toBe('ليس لديك صلاحية لهذا الإجراء.');
  });

  it('falls back on the hint, then the code', () => {
    expect(arabicError({ hint: 'insufficient_stock', message: 'whatever' })).toBe(
      'الكمية المطلوبة أكبر من المتاح في المخزون.',
    );
    expect(arabicError({ code: '23505', message: 'duplicate key value violates unique constraint' })).toBe(
      'هذا مسجّل بالفعل.',
    );
  });

  it('keeps an unknown message under an Arabic sentence', () => {
    expect(arabicError({ message: 'Something nobody planned for' })).toBe(
      'حدث خطأ غير متوقع. (Something nobody planned for)',
    );
    expect(arabicError(null)).toBe('حدث خطأ غير متوقع.');
  });

  it('reads server-function answers', () => {
    expect(arabicError('variant_upsert_failed · CSP-XL-GRY · duplicate key')).toBe(
      'تعذّر حفظ الصنف CSP-XL-GRY من شوبيفاي.',
    );
    expect(arabicError('Failed to fetch')).toBe('تعذّر الاتصال بالخادم. تأكد من الإنترنت وحاول مرة أخرى.');
  });
});
