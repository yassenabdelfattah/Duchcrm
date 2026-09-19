import { useEffect, useState } from 'react';
import { formatDateTime, type SyncIssueType } from '@duch/shared';
import { supabase } from '../lib/supabase';
import { useLocale } from '../i18n';
import { Badge, Button, Card, EmptyState, ErrorNote, Field, Input, Modal, Spinner } from '../components/ui';

interface SyncIssueRow {
  id: string;
  type: SyncIssueType;
  crm_quantity: number | null;
  shopify_quantity: number | null;
  occurrences: number;
  detected_at: string;
  details: Record<string, unknown>;
  variants: { sku: string; size: string | null; color: string | null } | null;
}

type Action = 'trust_crm' | 'trust_shopify' | 'ignore';

/**
 * The review queue for everywhere the CRM and Shopify disagree.
 *
 * Nothing on this screen happens automatically. Each of the three answers has
 * a different consequence and only a person standing near the actual rail of
 * clothes knows which one is true.
 */
export function SyncIssues() {
  const { t, locale } = useLocale();
  const [issues, setIssues] = useState<SyncIssueRow[] | null>(null);
  const [resolving, setResolving] = useState<SyncIssueRow | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setIssues(null);

    supabase
      .from('sync_issues')
      .select(
        'id, type, crm_quantity, shopify_quantity, occurrences, detected_at, details, variants(sku, size, color)',
      )
      .eq('status', 'open')
      .order('detected_at', { ascending: false })
      .limit(200)
      .then(({ data }) => {
        if (!cancelled) setIssues((data ?? []) as unknown as SyncIssueRow[]);
      });

    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-extrabold">{t('sync.title')}</h1>

      {!issues ? (
        <Spinner label={t('app.loading')} />
      ) : issues.length === 0 ? (
        <EmptyState title={t('sync.empty')} />
      ) : (
        <div className="space-y-3">
          {issues.map((issue) => (
            <Card key={issue.id} className="flex flex-wrap items-center gap-4">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="warn">{t(`sync.${issue.type}`)}</Badge>
                  {issue.occurrences > 1 ? (
                    <span className="text-xs text-stone-500">
                      {t('sync.occurrences', { count: issue.occurrences })}
                    </span>
                  ) : null}
                </div>
                <p className="tabular mt-1 text-sm font-semibold">
                  {issue.variants?.sku ?? '—'}
                  {issue.variants?.size || issue.variants?.color
                    ? ` · ${[issue.variants.size, issue.variants.color].filter(Boolean).join(' / ')}`
                    : ''}
                </p>
                <p className="mt-0.5 text-xs text-stone-500">
                  {formatDateTime(issue.detected_at, locale)}
                </p>
              </div>

              {issue.type === 'quantity_mismatch' ? (
                <dl className="tabular flex gap-6 text-sm">
                  <div>
                    <dt className="text-xs text-stone-500">{t('sync.crmQuantity')}</dt>
                    <dd className="text-lg font-extrabold">{issue.crm_quantity ?? '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-stone-500">{t('sync.shopifyQuantity')}</dt>
                    <dd className="text-lg font-extrabold">{issue.shopify_quantity ?? '—'}</dd>
                  </div>
                </dl>
              ) : null}

              <Button variant="secondary" onClick={() => setResolving(issue)}>
                {t('sync.resolve')}
              </Button>
            </Card>
          ))}
        </div>
      )}

      <ResolveDialog
        issue={resolving}
        onClose={() => setResolving(null)}
        onDone={() => {
          setResolving(null);
          setReloadToken((token) => token + 1);
        }}
      />
    </div>
  );
}

function ResolveDialog({
  issue,
  onClose,
  onDone,
}: {
  issue: SyncIssueRow | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useLocale();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setNote('');
    setError(null);
  }, [issue?.id]);

  if (!issue) return null;

  // See the note in Stock.tsx: narrowing on a parameter does not survive into
  // a closure, so the checked value is captured here.
  const target = issue;

  async function apply(action: Action) {
    setBusy(true);
    setError(null);

    const { error: rpcError } = await supabase.rpc('resolve_sync_issue', {
      p_issue_id: target.id,
      p_action: action,
      p_note: note || null,
    });

    setBusy(false);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    onDone();
  }

  const choices: Array<{ action: Action; label: string; help: string }> = [
    { action: 'trust_crm', label: t('sync.trustCrm'), help: t('sync.trustCrmHelp') },
    { action: 'trust_shopify', label: t('sync.trustShopify'), help: t('sync.trustShopifyHelp') },
    { action: 'ignore', label: t('sync.ignore'), help: t('sync.ignoreHelp') },
  ];

  return (
    <Modal open title={t('sync.resolve')} onClose={onClose}>
      <div className="space-y-3">
        <Field label={t('sync.resolutionNote')}>
          <Input value={note} onChange={(event) => setNote(event.target.value)} />
        </Field>

        {error ? <ErrorNote>{error}</ErrorNote> : null}

        <div className="space-y-2">
          {choices.map((choice) => (
            <button
              key={choice.action}
              type="button"
              disabled={busy}
              onClick={() => apply(choice.action)}
              className="w-full rounded-lg border border-duch-line p-3 text-start transition-colors hover:bg-stone-50 disabled:opacity-60"
            >
              <span className="block text-sm font-bold">{choice.label}</span>
              <span className="block text-xs text-stone-500">{choice.help}</span>
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}
