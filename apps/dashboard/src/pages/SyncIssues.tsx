import { useEffect, useState } from 'react';
import { useGetIdentity } from '@refinedev/core';
import { can, formatDateTime, type SyncIssueType } from '@duch/shared';
import { supabase } from '../lib/supabase';
import { arabicError } from '../lib/errors';
import { useLocale } from '../i18n';
import type { StaffIdentity } from '../providers/authProvider';
import { Badge, Button, Card, EmptyState, ErrorNote, Field, Input, Modal, Spinner } from '../components/ui';

interface SyncIssueRow {
  id: string;
  type: SyncIssueType;
  crm_quantity: number | null;
  shopify_quantity: number | null;
  occurrences: number;
  detected_at: string;
  last_seen_at: string;
  details: Record<string, unknown>;
  variants: {
    sku: string;
    size: string | null;
    color: string | null;
    products: { title: string } | null;
  } | null;
}

/** Quantity differences for one product, settled together or one by one. */
interface ProductGroup {
  title: string;
  issues: SyncIssueRow[];
}

type Action = 'trust_crm' | 'trust_shopify' | 'ignore';

/**
 * The review queue for everywhere the CRM and Shopify disagree.
 *
 * Nothing on this screen happens automatically. Each of the three answers has
 * a different consequence and only a person standing near the actual rail of
 * clothes knows which one is true. What the screen does do is let that person
 * check again on demand, and give one answer for every size of a product.
 */
export function SyncIssues() {
  const { t, locale } = useLocale();
  const { data: identity } = useGetIdentity<StaffIdentity>();
  const mayResolve = can(identity?.permissions, 'sync.manage');

  const [issues, setIssues] = useState<SyncIssueRow[] | null>(null);
  // Issues about a whole product rather than a variant carry the Shopify
  // product id in details; its title is looked up so the card can name it.
  const [productTitles, setProductTitles] = useState<Record<string, string>>({});
  const [resolving, setResolving] = useState<{ title: string | null; issues: SyncIssueRow[] } | null>(
    null,
  );
  const [checking, setChecking] = useState(false);
  const [checkMessage, setCheckMessage] = useState<string | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setIssues(null);

    supabase
      .from('sync_issues')
      .select(
        'id, type, crm_quantity, shopify_quantity, occurrences, detected_at, last_seen_at, details, variants(sku, size, color, products(title))',
      )
      .eq('status', 'open')
      .order('detected_at', { ascending: false })
      .limit(500)
      .then(async ({ data }) => {
        if (cancelled) return;
        const rows = (data ?? []) as unknown as SyncIssueRow[];
        setIssues(rows);

        const productIds = [
          ...new Set(
            rows
              .map((row) => row.details?.shopify_product_id)
              .filter((id): id is number | string => id !== undefined && id !== null)
              .map(String),
          ),
        ];
        if (productIds.length === 0) return;

        const { data: products } = await supabase
          .from('products')
          .select('title, shopify_product_id')
          .in('shopify_product_id', productIds);
        if (cancelled) return;
        setProductTitles(
          Object.fromEntries(
            (products ?? []).map((p) => [String(p.shopify_product_id), p.title as string]),
          ),
        );
      });

    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  async function checkNow() {
    setChecking(true);
    setCheckMessage(null);
    setCheckError(null);

    const { data, error: invokeError } = await supabase.functions.invoke<{
      checked?: number;
      mismatched?: number;
      unmapped?: number;
    }>('reconcile-stock', { body: {} });

    setChecking(false);

    if (invokeError) {
      // supabase-js only says "non-2xx status code"; the reason is in the body.
      let message = invokeError.message;
      const context = (invokeError as { context?: Response }).context;
      if (context) {
        try {
          const body = (await context.json()) as { error?: string; detail?: string };
          message = [body.error, body.detail].filter(Boolean).join(' · ') || message;
        } catch {
          // Not JSON - keep the generic message.
        }
      }
      setCheckError(arabicError(message));
      return;
    }

    setCheckMessage(
      t('sync.checked', {
        checked: data?.checked ?? 0,
        mismatched: data?.mismatched ?? 0,
        unmapped: data?.unmapped ?? 0,
      }),
    );
    setReloadToken((token) => token + 1);
  }

  // Quantity differences are grouped by product, so a product edited in
  // Shopify is one decision rather than one per size. Everything else is
  // listed on its own below.
  const groups: ProductGroup[] = [];
  const others: SyncIssueRow[] = [];
  for (const issue of issues ?? []) {
    if (issue.type === 'quantity_mismatch' && issue.variants) {
      const title = issue.variants.products?.title ?? '—';
      let group = groups.find((g) => g.title === title);
      if (!group) {
        group = { title, issues: [] };
        groups.push(group);
      }
      group.issues.push(issue);
    } else {
      others.push(issue);
    }
  }
  groups.sort((a, b) => a.title.localeCompare(b.title));
  for (const group of groups) {
    group.issues.sort((a, b) => (a.variants?.sku ?? '').localeCompare(b.variants?.sku ?? ''));
  }

  function renderIssue(issue: SyncIssueRow) {
    return (
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
          {issue.variants ? (
            <p className="tabular mt-1 text-sm font-semibold">
              {issue.variants.sku}
              {issue.variants.size || issue.variants.color
                ? ` · ${[issue.variants.size, issue.variants.color].filter(Boolean).join(' / ')}`
                : ''}
            </p>
          ) : (
            // About a whole product, so there is no SKU to show - say
            // which product and what is wrong with it instead.
            <p className="mt-1 text-sm font-semibold">
              <bdi>
                {productTitles[String(issue.details?.shopify_product_id)] ??
                  (issue.details?.shopify_product_id
                    ? `#${String(issue.details.shopify_product_id)}`
                    : issue.details?.inventory_item_id
                      ? `Shopify #${String(issue.details.inventory_item_id)}`
                      : '—')}
              </bdi>
              {issue.details?.reason === 'variants_without_sku' ? (
                <span className="block text-xs font-normal text-stone-600">
                  {t('sync.noSkuDetail', { count: Number(issue.details?.count ?? 0) })}
                </span>
              ) : null}
            </p>
          )}
          <p className="mt-0.5 text-xs text-stone-500">
            {t('sync.lastChecked', { when: formatDateTime(issue.last_seen_at, locale) })}
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

        {mayResolve ? (
          <Button variant="secondary" onClick={() => setResolving({ title: null, issues: [issue] })}>
            {t('sync.resolve')}
          </Button>
        ) : null}
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-extrabold">{t('sync.title')}</h1>
        {mayResolve ? (
          <Button className="ms-auto" onClick={checkNow} disabled={checking}>
            {checking ? t('sync.checking') : t('sync.checkNow')}
          </Button>
        ) : null}
      </div>

      {checkMessage ? (
        <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800">
          {checkMessage}
        </p>
      ) : null}
      {checkError ? <ErrorNote>{checkError}</ErrorNote> : null}

      {!issues ? (
        <Spinner label={t('app.loading')} />
      ) : issues.length === 0 ? (
        <EmptyState title={t('sync.empty')} />
      ) : (
        <div className="space-y-6">
          {groups.map((group) => (
            <section key={group.title} className="space-y-3">
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="text-base font-bold">
                  <bdi>{group.title}</bdi>
                </h2>
                <span className="text-xs text-stone-500">
                  {t('sync.sizesDiffer', { count: group.issues.length })}
                </span>
                {mayResolve && group.issues.length > 1 ? (
                  <Button
                    variant="secondary"
                    className="ms-auto"
                    onClick={() => setResolving({ title: group.title, issues: group.issues })}
                  >
                    {t('sync.resolveAll', { count: group.issues.length })}
                  </Button>
                ) : null}
              </div>
              {group.issues.map(renderIssue)}
            </section>
          ))}

          {others.length > 0 ? <div className="space-y-3">{others.map(renderIssue)}</div> : null}
        </div>
      )}

      <ResolveDialog
        title={resolving?.title ?? null}
        issues={resolving?.issues ?? null}
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
  title,
  issues,
  onClose,
  onDone,
}: {
  title: string | null;
  issues: SyncIssueRow[] | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t, locale } = useLocale();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const key = issues?.map((issue) => issue.id).join(',') ?? '';
  useEffect(() => {
    setNote('');
    setError(null);
  }, [key]);

  if (!issues || issues.length === 0) return null;

  // See the note in Stock.tsx: narrowing on a parameter does not survive into
  // a closure, so the checked value is captured here.
  const targets = issues;
  const isBulk = targets.length > 1;
  const mismatches = targets.filter((issue) => issue.type === 'quantity_mismatch');

  // Accepting Shopify's count uses the numbers from the last check. Say how
  // old they are, so a change made in Shopify since then is not overwritten.
  const oldestCheck = targets
    .map((issue) => issue.last_seen_at)
    .reduce((oldest, when) => (when < oldest ? when : oldest));

  async function apply(action: Action) {
    setBusy(true);
    setError(null);

    const { error: rpcError } = await supabase.rpc('resolve_sync_issues', {
      p_issue_ids: targets.map((issue) => issue.id),
      p_action: action,
      p_note: note || null,
    });

    setBusy(false);
    if (rpcError) {
      setError(arabicError(rpcError));
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
    <Modal open title={title ?? t('sync.resolve')} onClose={onClose}>
      <div className="space-y-3">
        {isBulk && mismatches.length > 0 ? (
          <table className="tabular w-full text-sm">
            <thead>
              <tr className="text-xs text-stone-500">
                <th className="py-1 text-start font-semibold">{t('stock.sku')}</th>
                <th className="py-1 text-end font-semibold">{t('sync.crmQuantity')}</th>
                <th className="py-1 text-end font-semibold">{t('sync.shopifyQuantity')}</th>
              </tr>
            </thead>
            <tbody>
              {mismatches.map((issue) => (
                <tr key={issue.id} className="border-t border-duch-line">
                  <td className="py-1">{issue.variants?.sku}</td>
                  <td className="py-1 text-end">{issue.crm_quantity ?? '—'}</td>
                  <td className="py-1 text-end font-bold">{issue.shopify_quantity ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}

        {mismatches.length > 0 ? (
          <p className="text-xs text-stone-600">
            {t('sync.numbersFrom', { when: formatDateTime(oldestCheck, locale) })}
          </p>
        ) : null}

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
              <span className="block text-sm font-bold">
                {isBulk ? t('sync.forAll', { label: choice.label, count: targets.length }) : choice.label}
              </span>
              <span className="block text-xs text-stone-500">{choice.help}</span>
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}
