import { existsSync, readFileSync } from 'fs';
import { createHash } from 'node:crypto';
import { resolve } from 'path';

/** sha256 of the generic glasses icon that create-mentra-miniapp scaffolds. */
export const PLACEHOLDER_ICON_SHA256 = '240cdd3baf7777d9c2aabd066d4bdb427c44759409d67d74478999fb63e50d6a';

/** True when the project's icon.png is still the scaffolder's placeholder. */
export function isPlaceholderIcon(cwd: string): boolean {
  const iconPath = resolve(cwd, 'icon.png');
  if (!existsSync(iconPath)) return false;
  return createHash('sha256').update(readFileSync(iconPath)).digest('hex') === PLACEHOLDER_ICON_SHA256;
}

/** Warn when a project still ships the scaffolder's placeholder icon. */
export function warnIfPlaceholderIcon(cwd: string): void {
  if (!isPlaceholderIcon(cwd)) return;
  console.warn(
    'Warning: icon.png is still the create-mentra-miniapp placeholder. ' +
      'Replace it with a square PNG (at least 512x512) for this miniapp.',
  );
}
