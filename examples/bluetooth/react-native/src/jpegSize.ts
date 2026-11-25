/**
 * A JPEG's stored pixel size, from its frame header. `Image.getSize` can't be used: on Android it
 * reports a downsampled size for large photos (a 4032 x 3024 photo shows as 2016 x 1512).
 */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1]!;
    if (marker === 0xff) {
      i++; // fill byte
      continue;
    }
    // Start of frame, any coding but DHT (C4), JPG (C8) and DAC (CC): precision, height, width.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: (bytes[i + 5]! << 8) | bytes[i + 6]!, width: (bytes[i + 7]! << 8) | bytes[i + 8]! };
    }
    i += 2 + ((bytes[i + 2]! << 8) | bytes[i + 3]!);
  }
  return null;
}
