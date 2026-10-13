import { useState } from 'react';
import { Download, Share, Smartphone, SquarePlus, X } from 'lucide-react';
import { useLocale } from '../i18n';
import { useInstallApp } from '../hooks/useInstallApp';
import { Button, Modal } from './ui';

/**
 * "Install the app": a row for the More sheet, and a card for the home screen
 * on a phone that has not installed it yet. Android gets its own install
 * offer; an iPhone gets the two steps, since Safari has no button for it.
 */

const BANNER_KEY = 'duch.install.dismissed';

function IosSteps({ onClose }: { onClose: () => void }) {
  const { t } = useLocale();
  return (
    <Modal open title={t('install.title')} onClose={onClose}>
      <ol className="space-y-3 text-sm">
        <li className="flex items-center gap-3 rounded-xl bg-stone-50 p-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-white text-blue-600 ring-1 ring-duch-line">
            <Share className="size-5" />
          </span>
          {t('install.iosStep1')}
        </li>
        <li className="flex items-center gap-3 rounded-xl bg-stone-50 p-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-white ring-1 ring-duch-line">
            <SquarePlus className="size-5" />
          </span>
          {t('install.iosStep2')}
        </li>
      </ol>
      <p className="mt-3 text-xs text-stone-500">{t('install.iosNote')}</p>
    </Modal>
  );
}

/** A row in the More sheet; nothing once the app is installed. */
export function InstallAppRow() {
  const { t } = useLocale();
  const { canInstall, isIos, install } = useInstallApp();
  const [showSteps, setShowSteps] = useState(false);

  if (!canInstall) return null;

  return (
    <>
      <button
        type="button"
        onClick={async () => {
          if (!(await install()) && isIos) setShowSteps(true);
        }}
        className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-sm font-semibold hover:bg-stone-50"
      >
        <Download className="size-5" />
        <span className="flex-1 text-start">{t('install.button')}</span>
      </button>
      {showSteps ? <IosSteps onClose={() => setShowSteps(false)} /> : null}
    </>
  );
}

/** A card on the home screen, on phones only, until installed or dismissed. */
export function InstallBanner() {
  const { t } = useLocale();
  const { canInstall, isIos, install } = useInstallApp();
  const [showSteps, setShowSteps] = useState(false);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(BANNER_KEY) === '1';
    } catch {
      return false;
    }
  });

  if (!canInstall || dismissed) return null;

  function dismiss() {
    setDismissed(true);
    try {
      localStorage.setItem(BANNER_KEY, '1');
    } catch {
      // Shown again next visit; harmless.
    }
  }

  return (
    <div className="flex items-center gap-3 rounded-2xl bg-duch-ink p-4 text-white sm:hidden">
      <Smartphone className="size-7 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold">{t('install.bannerTitle')}</p>
        <p className="text-xs text-stone-300">{t('install.bannerBody')}</p>
      </div>
      <Button
        variant="secondary"
        className="min-h-9 shrink-0 px-3 text-xs"
        onClick={async () => {
          if (!(await install()) && isIos) setShowSteps(true);
        }}
      >
        {t('install.short')}
      </Button>
      <button type="button" aria-label={t('app.close')} onClick={dismiss} className="p-1 text-stone-400">
        <X className="size-4" />
      </button>
      {showSteps ? <IosSteps onClose={() => setShowSteps(false)} /> : null}
    </div>
  );
}
