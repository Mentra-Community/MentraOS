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
