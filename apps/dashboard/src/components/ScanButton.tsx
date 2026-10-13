import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Flashlight, FlashlightOff, ScanBarcode, X } from 'lucide-react';
import { useLocale } from '../i18n';
import { getDetector, hasCamera } from '../lib/barcode';
import { beep, buzz } from '../lib/chime';
import { cx } from './ui';

/**
 * A camera button that reads one barcode and hands it back - the same as a
 * USB scanner would type it. Put it beside any box a code goes into.
 */
export function ScanButton({ onScan, className }: { onScan: (code: string) => void; className?: string }) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);

  if (!hasCamera()) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t('scan.open')}
        title={t('scan.open')}
        className={cx(
          'flex min-h-11 shrink-0 items-center justify-center rounded-lg border border-duch-line bg-white px-3 text-duch-ink hover:bg-stone-50',
          className,
        )}
      >
        <ScanBarcode className="size-5" />
      </button>
      {/* On the page itself, not inside whatever dialog holds the button,
          so it always covers the whole screen. */}
      {open
        ? createPortal(
            <Scanner
              onClose={() => setOpen(false)}
              onScan={(code) => {
                setOpen(false);
                onScan(code);
              }}
            />,
            document.body,
          )
        : null}
    </>
  );
}

function Scanner({ onScan, onClose }: { onScan: (code: string) => void; onClose: () => void }) {
  const { t } = useLocale();
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(true);
  const [torch, setTorch] = useState<{ on: boolean; track: MediaStreamTrack } | null>(null);
  // The latest callback, so a re-render never restarts the camera.
  const scanned = useRef(onScan);
  scanned.current = onScan;

  useEffect(() => {
    let stream: MediaStream | null = null;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
      } catch (caught) {
        const name = (caught as { name?: string })?.name;
        setError(name === 'NotAllowedError' ? t('scan.denied') : name === 'NotFoundError' ? t('scan.noCamera') : t('scan.failed'));
        setStarting(false);
        return;
      }
      if (stopped || !video.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      video.current.srcObject = stream;
      await video.current.play().catch(() => undefined);
      setStarting(false);

      // A torch where the phone has one: labels in a dim stockroom.
      const track = stream.getVideoTracks()[0];
      const capabilities = track?.getCapabilities?.() as { torch?: boolean } | undefined;
      if (track && capabilities?.torch) setTorch({ on: false, track });

      const detector = await getDetector().catch(() => null);
      if (!detector) {
        setError(t('scan.failed'));
        return;
      }

      const look = async () => {
        if (stopped || !video.current) return;
        if (video.current.readyState >= 2) {
          try {
            const found = (await detector.detect(video.current)).find((code) => code.rawValue.trim());
            if (found && !stopped) {
              stopped = true;
              beep();
              buzz();
              scanned.current(found.rawValue.trim());
              return;
            }
          } catch {
            // A frame that could not be read; try the next.
          }
        }
        timer = setTimeout(() => void look(), 150);
      };
      void look();
    }

    void start();

    return () => {
      stopped = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [t]);

  async function toggleTorch() {
    if (!torch) return;
    const on = !torch.on;
    try {
      await torch.track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
      setTorch({ ...torch, on });
    } catch {
      setTorch(null);
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-black text-white" role="dialog" aria-modal="true" aria-label={t('scan.title')}>
      <video ref={video} playsInline muted className="absolute inset-0 size-full object-cover" />

      {/* The frame to aim with; everything outside it dimmed. */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className="h-44 w-[min(80vw,22rem)] rounded-2xl border-4 border-white/90 shadow-[0_0_0_100vmax_rgba(0,0,0,0.45)]" />
      </div>

      <div
        className="relative flex items-center justify-between p-4"
        style={{ paddingTop: 'calc(1rem + env(safe-area-inset-top, 0px))' }}
      >
        <button type="button" onClick={onClose} aria-label={t('app.close')} className="rounded-full bg-black/50 p-3">
          <X className="size-6" />
        </button>
        {torch ? (
          <button type="button" onClick={() => void toggleTorch()} aria-label={t('scan.torch')} className="rounded-full bg-black/50 p-3">
            {torch.on ? <FlashlightOff className="size-6" /> : <Flashlight className="size-6" />}
          </button>
        ) : null}
      </div>

      <div
        className="relative mt-auto p-6 text-center"
        style={{ paddingBottom: 'calc(1.5rem + env(safe-area-inset-bottom, 0px))' }}
      >
        <p className="text-base font-bold">{error ?? (starting ? t('app.loading') : t('scan.aim'))}</p>
      </div>
    </div>
  );
}
