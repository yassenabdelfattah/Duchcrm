/**
 * The "new order" chime: two short rising tones, made in the browser so there
 * is no sound file to load or to fail to load.
 *
 * Browsers only allow sound after the person has touched the page, so the
 * audio context is created on the first tap or key press and kept. Until
 * then a chime is silently skipped - the badge still shows.
 */

let context: AudioContext | null = null;

function unlock() {
  try {
    context ??= new AudioContext();
    if (context.state === 'suspended') void context.resume();
  } catch {
    // No Web Audio here; the chime simply never plays.
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', unlock, { passive: true });
  window.addEventListener('keydown', unlock);
}

export function playChime() {
  if (!context || context.state !== 'running') return;
  const start = context.currentTime;
  for (const [offset, frequency] of [
    [0, 880],
    [0.16, 1320],
  ] as const) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, start + offset);
    gain.gain.exponentialRampToValueAtTime(0.25, start + offset + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.22);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(start + offset);
    oscillator.stop(start + offset + 0.25);
  }
}

/** A short buzz on phones that support it (Android); ignored elsewhere. */
export function buzz() {
  try {
    navigator.vibrate?.([120, 60, 120]);
  } catch {
    // Not supported.
  }
}
