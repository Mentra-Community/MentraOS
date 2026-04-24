import qrcode from 'qrcode-terminal';

export function printQR(url: string): void {
  qrcode.generate(url, { small: true });
}
