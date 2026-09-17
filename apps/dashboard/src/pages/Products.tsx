import { useEffect, useState } from 'react';
import { useGetIdentity } from '@refinedev/core';
import { can } from '@duch/shared';
import { supabase } from '../lib/supabase';
import { useLocale } from '../i18n';
import type { StaffIdentity } from '../providers/authProvider';
import { Badge, Button, Card, EmptyState, ErrorNote, Spinner } from '../components/ui';

interface ProductRow {
  id: string;
  title: string;
  title_ar: string | null;
  status: 'active' | 'draft' | 'archived';
  image_url: string | null;
  shopify_product_id: number | null;
  variants: Array<{ count: number }>;
}

export function Products() {
  const { t, locale } = useLocale();
  const { data: identity } = useGetIdentity<StaffIdentity>();
  const mayImport = can(identity?.role, 'products.write');

  const [products, setProducts] = useState<ProductRow[] | null>(null);
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setProducts(null);

    supabase
      .from('products')
      .select('id, title, title_ar, status, image_url, shopify_product_id, variants(count)')
      .order('title')
      .limit(500)
      .then(({ data }) => {
        if (!cancelled) setProducts((data ?? []) as unknown as ProductRow[]);
      });

    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  async function importFromShopify() {
    setImporting(true);
    setError(null);
    setMessage(null);

    const { data, error: invokeError } = await supabase.functions.invoke<{
      summary?: { products_written: number; variants_written: number };
    }>('shopify-import-products', { body: {} });

    setImporting(false);

    if (invokeError) {
      setError(invokeError.message);
      return;
    }

    setMessage(
      t('products.imported', {
        products: data?.summary?.products_written ?? 0,
        variants: data?.summary?.variants_written ?? 0,
      }),
    );
    setReloadToken((token) => token + 1);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-extrabold">{t('products.title')}</h1>
        {mayImport ? (
          <Button className="ms-auto" onClick={importFromShopify} disabled={importing}>
            {importing ? t('products.importing') : t('products.import')}
          </Button>
        ) : null}
      </div>

      {message ? (
        <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800">
          {message}
        </p>
      ) : null}
      {error ? <ErrorNote>{error}</ErrorNote> : null}

      {!products ? (
        <Spinner label={t('app.loading')} />
      ) : products.length === 0 ? (
        <EmptyState
          title={t('stock.empty')}
          action={
            mayImport ? (
              <Button onClick={importFromShopify} disabled={importing}>
                {t('products.import')}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {products.map((product) => (
            <Card key={product.id} className="flex gap-3">
              {product.image_url ? (
                <img
                  src={product.image_url}
                  alt=""
                  loading="lazy"
                  className="size-16 shrink-0 rounded-lg object-cover"
                />
              ) : (
                <div className="size-16 shrink-0 rounded-lg bg-stone-100" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold">
                  {locale === 'ar' && product.title_ar ? product.title_ar : product.title}
                </p>
                <p className="mt-0.5 text-xs text-stone-500">
                  {t('products.variants', { count: product.variants?.[0]?.count ?? 0 })}
                </p>
                <div className="mt-2 flex flex-wrap gap-1">
                  <Badge tone={product.status === 'active' ? 'good' : 'neutral'}>
                    {product.status}
                  </Badge>
                  {product.shopify_product_id === null ? (
                    <Badge tone="warn">{t('stock.notSynced')}</Badge>
                  ) : null}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
