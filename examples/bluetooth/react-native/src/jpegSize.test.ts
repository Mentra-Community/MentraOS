import {describe, expect, test} from 'bun:test';
import {jpegSize} from './jpegSize';

/** SOI, an APP1 (EXIF) segment of `exifBytes`, a DQT, then a frame header of this size. */
function jpeg(width: number, height: number, frame = 0xc0, exifBytes = 1000) {
  const app1 = [0xff, 0xe1, (exifBytes + 2) >> 8, (exifBytes + 2) & 0xff, ...new Array(exifBytes).fill(0)];
  const dqt = [0xff, 0xdb, 0x00, 0x04, 0x00, 0x00];
  const sof = [0xff, frame, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03];
  return Uint8Array.from([0xff, 0xd8, ...app1, ...dqt, ...sof, 0, 0, 0, 0, 0, 0, 0, 0]);
}

describe('jpegSize', () => {
  test('reads the full sensor size past an EXIF segment, where Image.getSize downsamples', () => {
    expect(jpegSize(jpeg(4032, 3024))).toEqual({width: 4032, height: 3024});
  });
  test('reads a progressive frame header', () => {
    expect(jpegSize(jpeg(1280, 960, 0xc2))).toEqual({width: 1280, height: 960});
  });
  test('is null for anything that is not a JPEG or has no frame header in the bytes read', () => {
    expect(jpegSize(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(jpegSize(jpeg(4032, 3024).slice(0, 500))).toBeNull();
  });
});
