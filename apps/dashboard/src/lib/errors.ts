/**
 * Errors, in Arabic.
 *
 * The database explains a refusal in English ("Order D2610-00021 is already
 * out"), because those messages are also read by developers and tests. Staff
 * read Arabic, so every message that reaches the screen goes through here
 * first. A message we know is translated, keeping the order number or amount
 * it carries; one we do not know still gets an Arabic sentence, with the
 * original underneath so a screenshot is enough to diagnose it.
 */

interface ErrorLike {
  code?: string | null;
  message?: string | null;
  hint?: string | null;
}

type Rule = [RegExp, (match: RegExpExecArray) => string];

// Order matters: the first rule that matches wins, so more specific patterns
// come before the general ones that would also match them.
const RULES: Rule[] = [
  // --- Orders: closed, paid, cancelled -------------------------------------
  [/^Order (\S+) was returned, so nothing is owed on it/, (m) => `الطلب ${m[1]} مرتجع، فلا يوجد عليه مستحق.`],
  [/^Order (\S+) was returned\. Its money and items are closed/, (m) => `الطلب ${m[1]} مرتجع، فمبالغه وأصنافه مغلقة. يمكن تعديل الملاحظة فقط.`],
  [/^Order (\S+) has been paid for\./, (m) => `الطلب ${m[1]} مدفوع، فلا يمكن تغيير مبالغه. سجّل مرتجعاً بدلاً من ذلك.`],
  [/^Order (\S+) is on a courier statement/, (m) => `الطلب ${m[1]} مسجّل في كشف شركة الشحن وتمت محاسبته.`],
  [/^Order (\S+) was cancelled and cannot be edited/, (m) => `الطلب ${m[1]} ملغي ولا يمكن تعديله.`],
  [/^Order (\S+) was cancelled/, (m) => `الطلب ${m[1]} ملغي.`],
  [/^Order (\S+) is cancelled/, (m) => `الطلب ${m[1]} ملغي.`],
  [/^A cancelled order cannot be marked paid/, () => 'لا يمكن تسجيل طلب ملغي كمدفوع.'],
  [/^A cash-on-delivery order becomes paid when its settlement is reviewed/, () => 'طلب الدفع عند الاستلام يصبح مدفوعاً عند مراجعة كشف شركة الشحن.'],
  [/^Order (\S+) is not marked paid, so there is nothing to reopen/, (m) => `الطلب ${m[1]} غير مدفوع، فلا يوجد ما يُعاد فتحه.`],
  [/^Only the owner can reopen a paid order/, () => 'إعادة فتح دفعة مسجّلة متاحة للمالك فقط.'],
  [/^Say why this payment is being reopened/, () => 'اكتب سبب إعادة فتح الدفعة.'],

  // --- Orders: shipping and delivery ---------------------------------------
  [/^Enter the courier/, () => 'اكتب رقم شحنة المندوب.'],
  [/^Order (\S+) is already out, or the courier already has it/, (m) => `الطلب ${m[1]} خرج بالفعل أو استلمه المندوب.`],
  [/^Order (\S+) is already out/, (m) => `الطلب ${m[1]} خرج بالفعل.`],
  [/^Order (\S+) is not packed, or the courier already has it/, (m) => `الطلب ${m[1]} غير جاهز أو استلمه المندوب بالفعل.`],
  [/^Order (\S+) is not packed, so it cannot go out yet/, (m) => `الطلب ${m[1]} غير جاهز للخروج بعد.`],
  [/^Order (\S+) is not ready to pack/, (m) => `الطلب ${m[1]} غير جاهز للتجهيز.`],
  [/^Only a packed order can be put back/, () => 'يمكن إرجاع الطلب المجهز فقط إلى التجهيز.'],
  [/^Order (\S+) has moved past confirmation/, (m) => `الطلب ${m[1]} تجاوز مرحلة التأكيد.`],
  [/^Order (\S+) is not out with one of our own drivers/, (m) => `الطلب ${m[1]} ليس مع أحد مندوبينا.`],
  [/^Order (\S+) is already with the courier or delivered/, (m) => `الطلب ${m[1]} مع شركة الشحن أو تم تسليمه. سجّل مرتجعاً بدلاً من ذلك.`],
  [/^Say who is delivering it/, () => 'اكتب اسم من سيقوم بالتوصيل.'],
  [/^Shipment (\S+) has no tracking number/, () => 'لا يوجد رقم شحنة. سجّل رقم المندوب قبل التسليم.'],
  [/^No shipment with tracking code (\S+)/, (m) => `لا توجد شحنة برقم ${m[1]}.`],
  [/^No default location is configured to ship from/, () => 'لم يتم تحديد فرع افتراضي للشحن منه.'],

  // --- Returns -----------------------------------------------------------------
  [/^Order (\S+) already has an open return/, (m) => `الطلب ${m[1]} عليه مرتجع مفتوح بالفعل.`],
  [/^Order (\S+) was never delivered, so there is nothing to return/, (m) => `الطلب ${m[1]} لم يُسلَّم، فلا يوجد ما يُرتجع.`],
  [/^Return line \S+ does not belong to return/, () => 'هذا الصنف لا يتبع هذا المرتجع.'],
  [/^Return \S+ not found/, () => 'المرتجع غير موجود.'],

  // --- Editing an order --------------------------------------------------------
  [/^An order needs at least one item/, () => 'الطلب يحتاج صنفاً واحداً على الأقل. ألغِ الطلب بدلاً من ذلك.'],
  [/^A sale needs at least one item/, () => 'أضف صنفاً واحداً على الأقل.'],
  [/^A discount of (\S+) is larger than the order subtotal of (\S+)/, (m) => `الخصم ${m[1]} أكبر من مجموع الطلب ${m[2]}.`],
  [/^(The )?[Oo]rder discount is (now )?larger than the order subtotal/, () => 'الخصم أكبر من مجموع الطلب.'],
  [/^A discount cannot be negative/, () => 'الخصم لا يمكن أن يكون بالسالب.'],
  [/^Shipping cannot be negative/, () => 'الشحن لا يمكن أن يكون بالسالب.'],
  [/^Line discount for (\S+) is larger than the line total/, (m) => `خصم الصنف ${m[1]} أكبر من سعره.`],
  [/^Quantity for (\S+) must be a positive whole number/, (m) => `كمية ${m[1]} يجب أن تكون رقماً صحيحاً موجباً.`],
  [/^Variant (\S+)(?: \((\S+)\))? is not active and cannot be sold/, (m) => `الصنف ${m[2] ?? m[1]} غير مفعّل ولا يمكن بيعه.`],
  [/^Unknown variant/, () => 'الصنف غير موجود.'],

  // --- Stock -------------------------------------------------------------------
  [/insufficient_stock/, () => 'الكمية المطلوبة أكبر من المتاح في المخزون.'],
  [/^An adjustment of zero changes nothing/, () => 'اكتب كمية غير الصفر.'],
  [/^An adjustment needs a description/, () => 'اكتب سبب التسوية.'],
  [/^Role \S+ may not record a \S+ movement/, () => 'ليس لديك صلاحية لتسجيل هذه الحركة.'],
  [/is append-only/, () => 'لا يمكن تعديل السجل أو حذفه. سجّل حركة تصحيح بدلاً من ذلك.'],

  // --- Settlements ---------------------------------------------------------------
  [/^Settlement does not balance: the bank received (\S+), the lines add up to (\S+), a difference of (\S+)/,
    (m) => `الكشف غير متوازن: المبلغ المستلم ${m[1]}، ومجموع البنود ${m[2]}، والفرق ${m[3]}.`],
  [/^(\S+) is already on this statement/, (m) => `${m[1]} موجود بالفعل في هذا الكشف.`],
  [/^Settlement \S+ has already been reviewed|^That settlement has already been reviewed/, () => 'تمت مراجعة هذا الكشف ولا يمكن تغييره.'],
  [/^Settlement \S+ is not open for editing/, () => 'هذا الكشف غير مفتوح للتعديل.'],
  [/^Settlement \S+ not found/, () => 'الكشف غير موجود.'],

  // --- Staff and sync --------------------------------------------------------------
  [/^Cannot (delete|remove) the last active admin/, () => 'لا يمكن إزالة آخر مدير مفعّل.'],
  [/^Only the owner can change the owner|^The owner mark can only be set in the database/, () => 'حساب المالك لا يمكن تغييره من هنا.'],
  [/^Shopify gave no number for this item/, () => 'شوبيفاي لم يرسل كمية لهذا الصنف، فلا يوجد ما يُقبل.'],
  [/^This issue has no variant to adjust/, () => 'هذه المشكلة غير مرتبطة بصنف لتعديله.'],
  [/^Sync issue \S+ not found/, () => 'المشكلة غير موجودة.'],

  // --- Taking stock out -------------------------------------------------------------------
  [/^Say why the stock is going out/, () => 'اكتب سبب الإخراج.'],
  [/^Choose at least one item to take out/, () => 'اختر صنفاً واحداً على الأقل.'],
  [/^Choose at least one item that came back/, () => 'اختر ما رجع.'],
  [/^More is coming back than went out/, () => 'الراجع أكثر مما خرج.'],
  [/^This stock-out is already closed/, () => 'هذا الإخراج مغلق بالفعل.'],
  [/^Stock-out \S+ not found/, () => 'الإخراج غير موجود.'],

  // --- Roles -----------------------------------------------------------------------------
  [/^You cannot give a role with permissions you do not have yourself/, () => 'لا يمكنك إعطاء دور فيه صلاحيات ليست لديك.'],
  [/^Only an admin can change an admin/, () => 'المسؤول لا يغيّره إلا مسؤول.'],
  [/^The built-in roles cannot be changed/, () => 'الأدوار الأساسية لا يمكن تعديلها أو حذفها.'],
  [/^This role is still given to (\d+) staff/, (m) => `هذا الدور مع ${m[1]} موظف. غيّر أدوارهم أولاً.`],
  [/^A role called (.+) already exists/, (m) => `يوجد دور باسم ${m[1]} بالفعل.`],
  [/^Give the role a name/, () => 'اكتب اسم الدور.'],
  [/^Unknown permission/, () => 'صلاحية غير معروفة.'],
  [/^Role \S+ not found/, () => 'الدور غير موجود.'],

  // --- Not found -------------------------------------------------------------------
  [/^(Order \S+ not found|Unknown order)/, () => 'الطلب غير موجود.'],
  [/^Shipment \S+ not found/, () => 'الشحنة غير موجودة.'],

  // --- Permissions, in any wording -------------------------------------------------
  [/^(You may not|Only an admin|Only the owner|Not allowed|Not an active staff member)/, () => 'ليس لديك صلاحية لهذا الإجراء.'],

  // --- Answers from our server functions (import, Shopify check) ------------------------
  [/^variant_upsert_failed(?: · (\S+))?/, (m) => `تعذّر حفظ الصنف${m[1] ? ` ${m[1]}` : ''} من شوبيفاي.`],
  [/^product_upsert_failed/, () => 'تعذّر حفظ أحد المنتجات من شوبيفاي.'],
  [/^(shopify_query_failed|shopify_read_failed)/, () => 'تعذّر قراءة البيانات من شوبيفاي. حاول مرة أخرى بعد قليل.'],
  [/^invalid_shopify_location_id/, () => 'إعداد فرع شوبيفاي غير صحيح.'],
  [/^not_allowed/, () => 'ليس لديك صلاحية لهذا الإجراء.'],
  [/^(reconcile_failed|verify_failed|opening_stock_failed|variant_lookup_failed|unhandled_error)/,
    (m) => `تعذّر إكمال العملية على الخادم. (${m[1]})`],

  // --- Network and server ------------------------------------------------------------
  [/Failed to fetch|NetworkError|Load failed/i, () => 'تعذّر الاتصال بالخادم. تأكد من الإنترنت وحاول مرة أخرى.'],
  [/non-2xx status code/, () => 'تعذّر تنفيذ العملية على الخادم.'],
  [/JWT expired|not_signed_in/i, () => 'انتهت الجلسة. سجّل الدخول مرة أخرى.'],
];

const BY_HINT: Record<string, string> = {
  insufficient_stock: 'الكمية المطلوبة أكبر من المتاح في المخزون.',
  order_already_paid: 'الطلب مدفوع، فلا يمكن تغيير مبالغه. سجّل مرتجعاً بدلاً من ذلك.',
  order_cancelled: 'الطلب ملغي ولا يمكن تعديله.',
  order_on_settlement: 'الطلب مسجّل في كشف شركة الشحن وتمت محاسبته.',
  order_returned: 'الطلب مرتجع ومغلق.',
  duplicate_settlement_line: 'هذا الطلب موجود بالفعل في هذا الكشف.',
};

const BY_CODE: Record<string, string> = {
  '42501': 'ليس لديك صلاحية لهذا الإجراء.',
  '23505': 'هذا مسجّل بالفعل.',
  '23514': 'لا يمكن تنفيذ هذا الإجراء على حالته الحالية.',
  P0002: 'غير موجود.',
  '22023': 'البيانات المدخلة غير صحيحة.',
};

/** The Arabic sentence to show for an error from Supabase, a function, or the network. */
export function arabicError(error: ErrorLike | string | null | undefined): string {
  if (!error) return 'حدث خطأ غير متوقع.';
  const { code, message, hint } =
    typeof error === 'string' ? { code: null, message: error, hint: null } : error;
  const text = message ?? '';

  for (const [pattern, render] of RULES) {
    const match = pattern.exec(text);
    if (match) return render(match);
  }

  if (hint && BY_HINT[hint]) return BY_HINT[hint];
  if (code && BY_CODE[code]) return BY_CODE[code];

  // Unknown: still Arabic first, with the original kept for whoever has to
  // work out what happened from a screenshot.
  return text ? `حدث خطأ غير متوقع. (${text})` : 'حدث خطأ غير متوقع.';
}
