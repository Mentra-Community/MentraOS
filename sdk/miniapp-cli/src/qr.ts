import QRCode from 'qrcode';

export function printQR(url: string): void {
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
  // The callback runs synchronously for the terminal renderer, so this stays a
  // simple void function and output order is preserved at the call sites.
  QRCode.toString(url, { type: 'terminal', small: true }, (err, str) => {
    if (err) {
      // The caller prints the raw URL right after this, so a render failure is
      // recoverable — just surface it and let the URL fallback stand.
      console.error(`Could not render QR code: ${err.message}`);
      return;
    }
    process.stdout.write(str);
  });
}
