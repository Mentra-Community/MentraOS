import qrcode from 'qrcode-terminal';

export function printQR(url: string): void {
  // NOTE: do not use `{ small: true }`. The compact mode packs two QR rows
  // into one terminal line using vertical half-block glyphs (▀ ▄ █), which
  // only scan when the terminal renders zero inter-line spacing. macOS
  // Terminal.app (default) and some embedded terminals (Codex desktop, etc.)
  // add line leading / anti-alias the blocks, leaving horizontal gaps that
  // misalign the modules and make the QR unscannable ("corrupted"). Full-size
  // mode packs only horizontally (2-char-wide blocks / spaces) and tiles
  // reliably across every terminal.
  qrcode.generate(url);
}
