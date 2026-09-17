import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { I18nProvider } from '@refinedev/core';
import en from './en.json';
import ar from './ar.json';

export type Locale = 'ar' | 'en';

const DICTIONARIES: Record<Locale, Record<string, unknown>> = { en, ar };
const STORAGE_KEY = 'duch.locale';

function readStoredLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'ar' || saved === 'en') return saved;
  } catch {
    // Private browsing. Fall through to the default.
  }
  const configured = import.meta.env.VITE_DEFAULT_LOCALE;
  return configured === 'en' ? 'en' : 'ar';
}

/** Looks up "sale.complete" in the dictionary. */
function lookup(dictionary: Record<string, unknown>, key: string): string | undefined {
  const value = key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
      dictionary,
    );
  return typeof value === 'string' ? value : undefined;
}

/** Replaces {{count}} style placeholders. */
function interpolate(template: string, params?: Record<string, unknown>): string {
  if (!params) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

interface LocaleContextValue {
  locale: Locale;
  dir: 'rtl' | 'ltr';
  setLocale: (locale: Locale) => void;
  t: (key: string, params?: Record<string, unknown>) => string;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(readStoredLocale);

  // Direction and language live on <html> so that Tailwind's logical
  // properties (ms-, me-, text-start) flip the whole interface, rather than
  // every component having to know which way round it is.
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
    try {
      localStorage.setItem(STORAGE_KEY, locale);
    } catch {
      // Not being able to remember the choice is survivable.
    }
  }, [locale]);

  const t = useCallback(
    (key: string, params?: Record<string, unknown>) => {
      const template =
        lookup(DICTIONARIES[locale], key) ??
        // Fall back to English rather than showing a raw key to a customer-
        // facing screen; an untranslated string is better than "sale.total".
        lookup(DICTIONARIES.en, key) ??
        key;
      return interpolate(template, params);
    },
    [locale],
  );

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      dir: locale === 'ar' ? 'rtl' : 'ltr',
      setLocale: setLocaleState,
      t,
    }),
    [locale, t],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  const context = useContext(LocaleContext);
  if (!context) throw new Error('useLocale must be used inside a LocaleProvider');
  return context;
}

/** Shorthand for components that only need the translate function. */
export function useT() {
  return useLocale().t;
}

/**
 * Bridges our locale context into Refine, so Refine's own strings and any
 * resource labels resolve through the same dictionaries.
 */
export function buildI18nProvider(context: LocaleContextValue): I18nProvider {
  return {
    translate: (key: string, options?: Record<string, unknown>, defaultMessage?: string) =>
      lookup(DICTIONARIES[context.locale], key) ??
      defaultMessage ??
      context.t(key, options),
    changeLocale: (locale: string) => {
      context.setLocale(locale === 'en' ? 'en' : 'ar');
      return Promise.resolve();
    },
    getLocale: () => context.locale,
  };
}
