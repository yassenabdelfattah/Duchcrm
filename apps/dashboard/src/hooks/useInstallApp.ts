import { useCallback, useEffect, useState } from 'react';

/**
 * Installing the CRM as an app on a phone.
 *
 * Android Chrome (and desktop Chrome and Edge) offer installing through an
 * event the page can keep and replay from a button; index.html keeps it,
 * because it can fire before React has mounted. iPhones have no such event:
 * installing is Share, then "Add to Home Screen", so there the button shows
 * those steps instead.
 */

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

declare global {
  interface Window {
    __duchInstallPrompt?: InstallPromptEvent | null;
  }
}

function isStandalone(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function useInstallApp() {
  const [promptEvent, setPromptEvent] = useState<InstallPromptEvent | null>(
    () => window.__duchInstallPrompt ?? null,
  );
  const [installed, setInstalled] = useState(isStandalone);

  useEffect(() => {
    const onInstallable = () => setPromptEvent(window.__duchInstallPrompt ?? null);
    const onInstalled = () => {
      window.__duchInstallPrompt = null;
      setPromptEvent(null);
      setInstalled(true);
    };
    window.addEventListener('duch:installable', onInstallable);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('duch:installable', onInstallable);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) && !installed;

  /** Shows the phone's own install offer. Returns false where there is none (iPhone). */
  const install = useCallback(async (): Promise<boolean> => {
    if (!promptEvent) return false;
    // An offer can be shown once. Forget it everywhere - the banner and the
    // More row each hold it - whatever the answer; Chrome sends a new one
    // later if it was turned down.
    window.__duchInstallPrompt = null;
    window.dispatchEvent(new Event('duch:installable'));
    try {
      await promptEvent.prompt();
      await promptEvent.userChoice;
    } catch {
      // Already used, or the browser refused to show it.
    }
    return true;
  }, [promptEvent]);

  return {
    installed,
    isIos,
    canInstall: !installed && (promptEvent !== null || isIos),
    install,
  };
}
