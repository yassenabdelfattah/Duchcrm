import { useState } from 'react';
import { formatEGP } from '@duch/shared';
import { supabase } from '../../lib/supabase';
import { arabicError } from '../../lib/errors';
import { useLocale } from '../../i18n';
import { Button, Code, Modal } from '../../components/ui';
import { payable, type BulkAction, type OrderRow } from './model';

/**
 * Marks the ticked orders paid, or received, one after another - each through
 * the same database function a single tap uses, so the same rules apply.
 * Says first how many and how much, and afterwards which, if any, were
 * refused and why.
 */
export function BulkDialog({
  action,
  rows,
  skipped,
  onClose,
  onDone,
}: {
  action: BulkAction;
  rows: OrderRow[];
  skipped: number;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const { t, locale } = useLocale();
  const [done, setDone] = useState<number | null>(null);
  const total = rows.reduce((sum, row) => sum + payable(row), 0);

  async function run() {
    const failures: string[] = [];
    let ok = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!;
      setDone(index);
      const { error } = await supabase.rpc(action, { p_order_id: row.id });
      if (error) failures.push(`${row.order_number}: ${arabicError(error)}`);
      else ok += 1;
    }
    const message = t(action === 'mark_order_paid' ? 'orders.bulk.donePaid' : 'orders.bulk.doneReceived', {
      count: ok,
    });
    onDone(
      failures.length > 0
        ? `${message} ${t('orders.bulk.failed', { count: failures.length, list: failures.join(' · ') })}`
        : message,
    );
  }

  return (
    <Modal
      open
      title={t(action === 'mark_order_paid' ? 'orders.bulk.confirmPaidTitle' : 'orders.bulk.confirmReceivedTitle', {
        count: rows.length,
      })}
      onClose={done === null ? onClose : () => undefined}
    >
      <div className="space-y-3">
        <p className="tabular flex flex-wrap gap-x-2 gap-y-1 rounded-lg bg-stone-50 px-3 py-2 text-xs">
          {rows.map((row) => (
            <Code key={row.id}>{row.order_number}</Code>
          ))}
        </p>
        {action === 'mark_order_paid' ? (
          <p className="tabular text-base font-extrabold">{t('orders.bulk.total', { amount: formatEGP(total, locale) })}</p>
        ) : null}
        {skipped > 0 ? <p className="text-xs text-stone-500">{t('orders.bulk.skipped', { count: skipped })}</p> : null}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={done !== null}>
            {t('orders.keepOrder')}
          </Button>
          <Button onClick={() => void run()} disabled={done !== null}>
            {done !== null
              ? t('orders.bulk.progress', { done: done + 1, count: rows.length })
              : t('orders.bulk.confirm')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
