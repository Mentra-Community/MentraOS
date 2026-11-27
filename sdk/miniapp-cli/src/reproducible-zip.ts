import JSZip from 'jszip';

/**
 * Every entry's timestamp, folders included: the earliest a ZIP can record.
 * A ZIP holds no time zone, and JSZip writes and reads these fields as UTC, so
 * the bytes don't depend on where the ZIP is made.
 */
export const ZIP_ENTRY_DATE = new Date(Date.UTC(1980, 0, 1));

/** One file of a ZIP: its path in the ZIP, with `/` between folders, and its content. */
export interface ZipFile {
  entry: string;
  bytes: Uint8Array;
}

/**
 * A ZIP that is the same bytes whenever it is made from the same files.
 *
 * A build is identified by its ZIP's SHA-256: the hash a served miniapp.json
 * names, and what a phone compares to decide whether to update. So nothing of
 * where or when the ZIP was made may reach it: entries are written in name
 * order, every entry (folders included) carries one fixed date and the same
 * permissions, and the compression is the caller's to fix.
 */
export async function buildReproducibleZip(files: ZipFile[], compression: 'STORE' | 'DEFLATE'): Promise<Uint8Array> {
  const zip = new JSZip();
  const sorted = [...files].sort((a, b) => (a.entry < b.entry ? -1 : a.entry > b.entry ? 1 : 0));
  for (const { entry, bytes } of sorted) {
    zip.file(entry, bytes, { date: ZIP_ENTRY_DATE, unixPermissions: 0o100644 });
  }
  // JSZip dates the folders it adds for nested entries with the current time.
  zip.forEach((_path, file) => {
    file.date = ZIP_ENTRY_DATE;
    if (file.dir) file.unixPermissions = 0o040755;
  });
  return zip.generateAsync({
    type: 'uint8array',
    compression,
    compressionOptions: { level: 9 },
    platform: 'UNIX',
  });
}
