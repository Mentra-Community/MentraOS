import QRCode from 'qrcode';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

export async function printQR(url: string): Promise<void> {
  // We render with `qrcode` (node-qrcode), not `qrcode-terminal`, to fix two
  // distinct ways the QR came out unscannable for some users:
  //
  //  1. Theme inversion. `qrcode-terminal`'s compact mode prints raw half-block
  //     glyphs in the terminal's *default* foreground color, so on a dark theme
  //     (default macOS Terminal.app, Codex desktop terminal) it renders
  //     light-on-dark — an inverted QR most phone cameras can't read. node-qrcode
  //     emits explicit ANSI colors (white bg / black fg), forcing dark-on-light
  //     regardless of terminal theme.
  //  2. Height. A full-block QR is one terminal row per module (~39–43 rows for
  //     our deep links) and gets clipped in a default 24-row window — also
  //     unscannable. `small: true` packs two module rows per line (~23 rows),
  //     which fits while keeping the forced colors above.
  //
  try {
    const str = await QRCode.toString(url, {type: 'terminal', small: true});
    process.stdout.write(str);
  } catch (error) {
    console.error(`Could not render terminal QR code: ${(error as Error).message}`);
  }

  // Terminal line-height and font settings can distort half-block QRs. Always
  // provide a high-resolution PNG fallback that can be opened or command-clicked.
  const pngPath = join(tmpdir(), `mentra-miniapp-dev-qr-${process.pid}.png`);
  try {
    await QRCode.toFile(pngPath, url, {
      type: 'png',
      width: 1024,
      margin: 4,
      errorCorrectionLevel: 'M',
    });
    console.log(`\nHigh-resolution QR: file://${pngPath}`);
  } catch (error) {
    console.error(`Could not write QR image: ${(error as Error).message}`);
  }
}
