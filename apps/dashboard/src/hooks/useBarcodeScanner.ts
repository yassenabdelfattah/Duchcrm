import { useEffect, useRef } from 'react';

/**
 * Listens for a USB or Bluetooth barcode scanner.
 *
 * These scanners present themselves as keyboards: they "type" the barcode and
 * press Enter. The only thing separating that from a person typing is speed -
 * a scanner emits characters a few milliseconds apart, a human tens or
 * hundreds. So keystrokes arriving faster than the threshold are collected,
 * and a slow one resets the buffer.
 *
 * Listening on the document rather than an input means the cashier can scan
 * without first tapping the search box, which is what makes the till feel
 * quick. Typing into a field still works normally, because anything typed at
 * human speed never reaches the scan handler.
 */
export function useBarcodeScanner(
  onScan: (code: string) => void,
  options: { minLength?: number; maxKeyIntervalMs?: number; enabled?: boolean } = {},
) {
  const { minLength = 4, maxKeyIntervalMs = 40, enabled = true } = options;

  const buffer = useRef('');
  const lastKeyAt = useRef(0);
  // Kept in a ref so that changing the handler does not tear down the
  // listener mid-scan and lose half a barcode.
  const handler = useRef(onScan);
  handler.current = onScan;

  useEffect(() => {
    if (!enabled) return;

    function handleKeyDown(event: KeyboardEvent) {
      const now = Date.now();
      const gap = now - lastKeyAt.current;
      lastKeyAt.current = now;

      if (event.key === 'Enter') {
        const code = buffer.current;
        buffer.current = '';
        if (code.length >= minLength) {
          // Stop the Enter from also submitting whatever form has focus.
          event.preventDefault();
          handler.current(code);
        }
        return;
      }

      // Anything that is not a single printable character (Shift, Tab, arrow
      // keys) is not part of a barcode.
      if (event.key.length !== 1) return;

      if (gap > maxKeyIntervalMs) {
        // Too slow to be a scanner. Start over, treating this as the possible
        // first character of a new scan.
        buffer.current = event.key;
        return;
      }

      buffer.current += event.key;
    }

    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [enabled, minLength, maxKeyIntervalMs]);
}
