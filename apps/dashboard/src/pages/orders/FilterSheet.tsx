import { PAYMENT_METHODS } from '@duch/shared';
import { useLocale } from '../../i18n';
import { Button, Field, Input, Modal, Select } from '../../components/ui';
import { NO_FILTERS, SORTS, type Filters, type SortKey, type Translate } from './model';

export interface Chip {
  key: string;
  label: string;
  clear: Partial<Filters>;
}

/** What is narrowing the list right now, each chip removable on its own. */
export function activeFilterChips(filters: Filters, t: Translate): Chip[] {
  const chips: Chip[] = [];
  if (filters.channel) {
    chips.push({ key: 'channel', label: t(`channel.${filters.channel}`), clear: { channel: '' } });
  }
  if (filters.method) {
    chips.push({ key: 'method', label: t(`payment.${filters.method}`), clear: { method: '' } });
  }
  if (filters.paid) {
    chips.push({
      key: 'paid',
      label: filters.paid === 'paid' ? t('paymentStatus.paid') : t('paymentStatus.pending'),
      clear: { paid: '' },
    });
  }
  if (filters.delivery) {
    chips.push({ key: 'delivery', label: t(`orders.courier.${filters.delivery}`), clear: { delivery: '' } });
  }
  if (filters.governorate) {
    chips.push({ key: 'governorate', label: filters.governorate, clear: { governorate: '' } });
  }
  if (filters.period === 'range' && (filters.from || filters.to)) {
    chips.push({
      key: 'period',
      label: t('orders.filter.rangeChip', { from: filters.from || '…', to: filters.to || '…' }),
      clear: { period: '', from: '', to: '' },
    });
  } else if (filters.period && filters.period !== 'range') {
    const label = { today: 'reports.preset.today', '7': 'reports.preset.week', '30': 'reports.preset.month' }[
      filters.period
    ];
    chips.push({ key: 'period', label: t(label), clear: { period: '' } });
  }
  if (filters.exchange) chips.push({ key: 'exchange', label: t('orders.filter.exchange'), clear: { exchange: false } });
  if (filters.hasNote) chips.push({ key: 'hasNote', label: t('orders.filter.hasNote'), clear: { hasNote: false } });
  return chips;
}

/**
 * The filters people reach for every day, one tap each. A preset whose
 * filter is already on is left out - it is in the active chips instead.
 */
export function presetChips(filters: Filters, t: Translate): Array<{ key: string; label: string; set: Partial<Filters> }> {
  const presets: Array<{ key: string; label: string; on: boolean; set: Partial<Filters> }> = [
    { key: 'today', label: t('reports.preset.today'), on: filters.period !== '', set: { period: 'today', from: '', to: '' } },
    { key: 'cod', label: t('payment.cod'), on: filters.method !== '', set: { method: 'cod' } },
    { key: 'unpaid', label: t('paymentStatus.pending'), on: filters.paid !== '', set: { paid: 'unpaid' } },
    { key: 'accurate', label: t('orders.courier.accurate'), on: filters.delivery !== '', set: { delivery: 'accurate' } },
    { key: 'own', label: t('orders.courier.own'), on: filters.delivery !== '', set: { delivery: 'own' } },
    { key: 'exchange', label: t('orders.filter.exchange'), on: filters.exchange, set: { exchange: true } },
  ];
  return presets.filter((preset) => !preset.on);
}

export function FilterSheet({
  filters,
  sort,
  governorates,
  onChange,
  onSort,
  onClose,
}: {
  filters: Filters;
  sort: SortKey;
  governorates: string[];
  onChange: (filters: Filters) => void;
  onSort: (sort: SortKey) => void;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const set = (patch: Partial<Filters>) => onChange({ ...filters, ...patch });

  const pick = (
    label: string,
    value: string,
    allLabel: string,
    options: Array<[string, string]>,
    onPick: (value: string) => void,
  ) => (
    <Field label={label}>
      <Select value={value} onChange={(event) => onPick(event.target.value)}>
        <option value="">{allLabel}</option>
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </Select>
    </Field>
  );

  return (
    <Modal open title={t('orders.filters')} onClose={onClose}>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          {pick(
            t('orders.filter.label.channel'),
            filters.channel,
            t('orders.filter.channelAll'),
            ['store', 'online', 'dm'].map((value) => [value, t(`channel.${value}`)]),
            (channel) => set({ channel }),
          )}
          {pick(
            t('orders.filter.label.method'),
            filters.method,
            t('orders.filter.methodAll'),
            PAYMENT_METHODS.map((value) => [value, t(`payment.${value}`)]),
            (method) => set({ method }),
          )}
          {pick(
            t('orders.filter.label.paid'),
            filters.paid,
            t('orders.filter.paidAll'),
            [
              ['paid', t('paymentStatus.paid')],
              ['unpaid', t('paymentStatus.pending')],
            ],
            (paid) => set({ paid: paid as Filters['paid'] }),
          )}
          {pick(
            t('orders.filter.label.delivery'),
            filters.delivery,
            t('orders.filter.deliveryAll'),
            [
              ['accurate', t('orders.courier.accurate')],
              ['own', t('orders.courier.own')],
            ],
            (delivery) => set({ delivery: delivery as Filters['delivery'] }),
          )}
          {pick(
            t('orders.filter.label.governorate'),
            filters.governorate,
            t('orders.filter.governorateAll'),
            governorates.map((name) => [name, name]),
            (governorate) => set({ governorate }),
          )}
          {pick(
            t('orders.filter.label.period'),
            filters.period,
            t('orders.filter.periodAll'),
            [
              ['today', t('reports.preset.today')],
              ['7', t('reports.preset.week')],
              ['30', t('reports.preset.month')],
              ['range', t('orders.filter.range')],
            ],
            (period) => set({ period: period as Filters['period'], ...(period === 'range' ? {} : { from: '', to: '' }) }),
          )}
        </div>

        {filters.period === 'range' ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('orders.filter.from')}>
              <Input type="date" value={filters.from} onChange={(event) => set({ from: event.target.value })} />
            </Field>
            <Field label={t('orders.filter.to')}>
              <Input type="date" value={filters.to} onChange={(event) => set({ to: event.target.value })} />
            </Field>
          </div>
        ) : null}

        <div className="space-y-2">
          <label className="flex min-h-11 items-center gap-3 rounded-lg border border-duch-line px-3 text-sm font-semibold">
            <input
              type="checkbox"
              className="size-5 accent-duch-ink"
              checked={filters.exchange}
              onChange={(event) => set({ exchange: event.target.checked })}
            />
            {t('orders.filter.exchange')}
          </label>
          <label className="flex min-h-11 items-center gap-3 rounded-lg border border-duch-line px-3 text-sm font-semibold">
            <input
              type="checkbox"
              className="size-5 accent-duch-ink"
              checked={filters.hasNote}
              onChange={(event) => set({ hasNote: event.target.checked })}
            />
            {t('orders.filter.hasNote')}
          </label>
        </div>

        <Field label={t('orders.sortLabel')}>
          <Select value={sort} onChange={(event) => onSort(event.target.value as SortKey)}>
            {SORTS.map((key) => (
              <option key={key} value={key}>
                {t(`orders.sort.${key}`)}
              </option>
            ))}
          </Select>
        </Field>

        <div className="flex justify-between gap-2">
          <Button variant="ghost" onClick={() => onChange(NO_FILTERS)}>
            {t('orders.filter.clear')}
          </Button>
          <Button onClick={onClose}>{t('orders.filter.done')}</Button>
        </div>
      </div>
    </Modal>
  );
}
