/**
 * Reading a barcode from the phone's camera.
 *
 * Android Chrome has a barcode reader built in (BarcodeDetector); where it
 * reads the formats we need, that is used. iPhones have none, so they get
 * ZXing compiled to WebAssembly - served from our own build, never a CDN,
 * and only downloaded the first time someone opens the camera.
 *
 * Product labels are EAN-13; courier labels are Code 128; QR covers anything
 * else someone prints.
 */

const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'code_93', 'itf', 'qr_code'] as const;

export interface Detector {
  detect(source: HTMLVideoElement): Promise<Array<{ rawValue: string; format: string }>>;
}

interface NativeDetectorClass {
  new (options: { formats: string[] }): Detector;
  getSupportedFormats(): Promise<string[]>;
}

let detector: Promise<Detector> | null = null;

export function getDetector(): Promise<Detector> {
  detector ??= (async () => {
    const Native = (globalThis as { BarcodeDetector?: NativeDetectorClass }).BarcodeDetector;
    if (Native) {
      try {
        const supported = await Native.getSupportedFormats();
        if (supported.includes('ean_13') && supported.includes('code_128')) {
          return new Native({ formats: FORMATS.filter((format) => supported.includes(format)) });
        }
      } catch {
        // Fall through to the bundled reader.
      }
    }

    const [{ BarcodeDetector, prepareZXingModule }, wasm] = await Promise.all([
      import('barcode-detector/ponyfill'),
      import('zxing-wasm/reader/zxing_reader.wasm?url'),
    ]);
    prepareZXingModule({
      overrides: {
        locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasm.default : prefix + path),
      },
    });
    return new BarcodeDetector({ formats: [...FORMATS] }) as unknown as Detector;
  })();
  return detector;
}

/** Whether this device can show a camera at all. */
export function hasCamera(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);
}
