import {chmodSync, writeFileSync} from 'fs';
import QRCode from 'qrcode';

/**
 * Print a scannable QR to the terminal.
 *
 * Use the *large* terminal renderer (`small: false`), not half-blocks.
 * Half-block mode (`█▄▀`) packs two modules per row and breaks whenever the
 * terminal has non-1.0 line-height or odd font metrics — looks like noise and
 * often won't scan. The large renderer paints each module as two spaces with
 * forced ANSI black/white backgrounds (same scheme as qrcode-terminal), so
 * modules stay roughly square and readable on dark or light themes.
 */
export async function printQR(url: string): Promise<void> {
  try {
    const str = await QRCode.toString(url, {
      type: 'terminal',
      small: false,
      errorCorrectionLevel: 'M',
      margin: 1,
    });
    process.stdout.write('\n' + str);
  } catch (error) {
    console.error(`Could not render terminal QR code: ${(error as Error).message}`);
  }
}

/**
 * Write a PNG QR to disk with mode 0o600.
 *
 * Dev/release URLs can carry a signed attestation query param; writing with
 * restrictive permissions avoids a world-readable window on multi-user machines.
 * Failures only warn — a broken PNG write must not take down the server.
 */
export async function writeQRPng(url: string, outPath: string): Promise<void> {
  try {
    const buffer = await QRCode.toBuffer(url, {
      type: 'png',
      errorCorrectionLevel: 'M',
      margin: 2,
      scale: 8,
    });
    // mode on writeFileSync only applies to newly created files — always chmod
    // after write so overwrites of a looser-mode temp path stay private.
    writeFileSync(outPath, buffer, {mode: 0o600});
    chmodSync(outPath, 0o600);
  } catch (error) {
    console.warn(`Could not write QR PNG to ${outPath}: ${(error as Error).message}`);
  }
}
