package com.mentra.bluetoothsdk.utils;

import androidx.annotation.Nullable;

import java.nio.charset.StandardCharsets;

/**
 * Reads EXIF UserComment / ImageDescription from a TIFF block embedded in AVIF/HEIF when
 * {@link androidx.exifinterface.media.ExifInterface} cannot (e.g. some OEMs omit MMR EXIF keys).
 */
final class HeifExifTagReader {
    private static final int TAG_USER_COMMENT = 0x9286;
    private static final int TAG_IMAGE_DESCRIPTION = 0x010E;
    private static final int TAG_EXIF_IFD_POINTER = 0x8769;

    private HeifExifTagReader() {}

    @Nullable
    static String readImuJson(byte[] fileBytes) {
        int searchFrom = 0;
        while (true) {
            int exif = indexOf(fileBytes, new byte[] {'E', 'x', 'i', 'f', 0, 0}, searchFrom);
            if (exif < 0) {
                return null;
            }
            int tiff = exif + 6;
            if (tiff + 8 <= fileBytes.length && isTiffHeader(fileBytes, tiff)) {
                return readFromTiff(fileBytes, tiff);
            }
            searchFrom = exif + 1;
        }
    }

    private static boolean isTiffHeader(byte[] data, int tiff) {
        boolean littleEndian = data[tiff] == 'I' && data[tiff + 1] == 'I';
        boolean bigEndian = data[tiff] == 'M' && data[tiff + 1] == 'M';
        if (!littleEndian && !bigEndian) {
            return false;
        }
        int magic = readUInt16(data, tiff + 2, littleEndian);
        return magic == 0x002A;
    }

    @Nullable
    private static String readFromTiff(byte[] fileBytes, int tiff) {
        boolean littleEndian = fileBytes[tiff] == 'I' && fileBytes[tiff + 1] == 'I';
        int ifd0 = readInt(fileBytes, tiff + 4, littleEndian);
        int ifd0Offset = tiff + ifd0;
        if (ifd0 < 0 || ifd0Offset < tiff || (long) ifd0Offset + 2 > fileBytes.length) {
            return null;
        }
        String userComment = readTagString(fileBytes, tiff, ifd0Offset, TAG_USER_COMMENT, littleEndian);
        if (userComment != null && !userComment.isEmpty()) {
            return userComment;
        }
        userComment =
                readTagFromLinkedIfd(fileBytes, tiff, ifd0Offset, TAG_EXIF_IFD_POINTER, TAG_USER_COMMENT, littleEndian);
        if (userComment != null && !userComment.isEmpty()) {
            return userComment;
        }
        String imageDescription =
                readTagString(fileBytes, tiff, ifd0Offset, TAG_IMAGE_DESCRIPTION, littleEndian);
        if (imageDescription != null && !imageDescription.isEmpty()) {
            return imageDescription;
        }
        return readTagFromLinkedIfd(
                fileBytes, tiff, ifd0Offset, TAG_EXIF_IFD_POINTER, TAG_IMAGE_DESCRIPTION, littleEndian);
    }

    @Nullable
    private static String readTagFromLinkedIfd(
            byte[] data,
            int tiffStart,
            int ifdOffset,
            int pointerTag,
            int targetTag,
            boolean littleEndian) {
        if ((long) ifdOffset + 2 > data.length) {
            return null;
        }
        int count = readUInt16(data, ifdOffset, littleEndian);
        int entryStart = ifdOffset + 2;
        for (int i = 0; i < count; i++) {
            int entry = entryStart + i * 12;
            if ((long) entry + 12 > data.length) {
                return null;
            }
            int tag = readUInt16(data, entry, littleEndian);
            if (tag != pointerTag) {
                continue;
            }
            int subIfdOffset = readInt(data, entry + 8, littleEndian);
            int subIfdAbs = tiffStart + subIfdOffset;
            if (subIfdOffset < 0
                    || subIfdAbs < tiffStart
                    || (long) subIfdAbs + 2 > data.length) {
                return null;
            }
            return readTagString(data, tiffStart, subIfdAbs, targetTag, littleEndian);
        }
        return null;
    }

    private static int indexOf(byte[] data, byte[] needle, int fromIndex) {
        outer:
        for (int i = fromIndex; i <= data.length - needle.length; i++) {
            for (int j = 0; j < needle.length; j++) {
                if (data[i + j] != needle[j]) {
                    continue outer;
                }
            }
            return i;
        }
        return -1;
    }

    @Nullable
    private static String readTagString(
            byte[] data, int tiffStart, int ifdOffset, int tagId, boolean littleEndian) {
        if ((long) ifdOffset + 2 > data.length) {
            return null;
        }
        int count = readUInt16(data, ifdOffset, littleEndian);
        int entryStart = ifdOffset + 2;
        for (int i = 0; i < count; i++) {
            int entry = entryStart + i * 12;
            if ((long) entry + 12 > data.length) {
                return null;
            }
            int tag = readUInt16(data, entry, littleEndian);
            if (tag != tagId) {
                continue;
            }
            int type = readUInt16(data, entry + 2, littleEndian);
            int valueCount = readInt(data, entry + 4, littleEndian);
            int valueOffset = readInt(data, entry + 8, littleEndian);
            int valuePos = valueCount > 4 ? tiffStart + valueOffset : entry + 8;
            if (valueCount > 4 && (valueOffset < 0 || valuePos < tiffStart || valuePos > data.length)) {
                continue;
            }
            return decodeExifString(data, valuePos, valueCount, type);
        }
        return null;
    }

    @Nullable
    private static String decodeExifString(byte[] data, int offset, int count, int type) {
        if (count <= 0 || offset < 0) {
            return null;
        }
        long end = (long) offset + count;
        if (end > data.length) {
            return null;
        }
        if (type == 2) {
            int len = count;
            while (len > 0 && data[offset + len - 1] == 0) {
                len--;
            }
            return new String(data, offset, len, StandardCharsets.UTF_8);
        }
        if (type == 7 || type == 1) {
            if (count >= 8 && data[offset] == 'A' && data[offset + 1] == 'S') {
                int textStart = offset + 8;
                int textLen = count - 8;
                while (textLen > 0 && data[textStart + textLen - 1] == 0) {
                    textLen--;
                }
                return new String(data, textStart, textLen, StandardCharsets.UTF_8);
            }
            int len = count;
            while (len > 0 && data[offset + len - 1] == 0) {
                len--;
            }
            return new String(data, offset, len, StandardCharsets.UTF_8);
        }
        return null;
    }

    private static int readUInt16(byte[] data, int offset, boolean littleEndian) {
        if (littleEndian) {
            return (data[offset] & 0xFF) | ((data[offset + 1] & 0xFF) << 8);
        }
        return ((data[offset] & 0xFF) << 8) | (data[offset + 1] & 0xFF);
    }

    private static int readInt(byte[] data, int offset, boolean littleEndian) {
        if (littleEndian) {
            return (data[offset] & 0xFF)
                    | ((data[offset + 1] & 0xFF) << 8)
                    | ((data[offset + 2] & 0xFF) << 16)
                    | ((data[offset + 3] & 0xFF) << 24);
        }
        return ((data[offset] & 0xFF) << 24)
                | ((data[offset + 1] & 0xFF) << 16)
                | ((data[offset + 2] & 0xFF) << 8)
                | (data[offset + 3] & 0xFF);
    }
}
