package com.mentra.bluetoothsdk.utils;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Removes the Exif metadata item from glasses BLE AVIF so {@link com.radzivon.bartoshyk.avif.coder.HeifCoder}
 * can decode the image. EXIF is appended to {@code mdat} by the glasses encoder; libavif then fails if that
 * trailer is present. IMU JSON must be read from the original bytes before stripping.
 */
final class AvifExifStripper {
    private AvifExifStripper() {}

    static byte[] stripForDecode(byte[] avif) throws IOException {
        if (avif.length < 12) {
            return avif;
        }
        // Primary path: parse meta tables, remove Exif item from iloc/iinf/iref, truncate mdat.
        try {
            byte[] cleaned = stripUsingMetaTables(avif);
            if (cleaned.length < avif.length) {
                return cleaned;
            }
        } catch (IOException | RuntimeException ignored) {
            // Malformed BMFF can throw runtime parse errors (buffer/index); fall through to the
            // marker-based fallback rather than letting the decode crash.
        }
        // Fallback: truncate mdat at the Exif\0\0 marker AND purge Exif from meta tables.
        int exifMarker = lastExifMarkerOffset(avif);
        if (exifMarker < 0) {
            return avif;
        }
        return stripMdatTailAndMeta(avif, exifMarker);
    }

    /**
     * Truncates mdat at the {@code Exif\0\0} byte position, then removes the Exif item from
     * iloc/iinf/iref so HeifCoder does not try to seek to the now-absent data.
     */
    private static byte[] stripMdatTailAndMeta(byte[] avif, int exifMarker) throws IOException {
        List<BmffBox> top = parseTopLevel(avif);
        BmffBox ftyp = require(top, "ftyp");
        BmffBox meta = require(top, "meta");
        BmffBox mdat = require(top, "mdat");

        int fileOffset = 0;
        for (BmffBox box : top) {
            if ("mdat".equals(box.type)) {
                int payloadStart = fileOffset + 8;
                if (exifMarker >= payloadStart && exifMarker < payloadStart + box.payload.length) {
                    int newPayloadLen = exifMarker - payloadStart;
                    if (newPayloadLen <= 0) {
                        return avif;
                    }
                    byte[] newMdatPayload = Arrays.copyOf(box.payload, newPayloadLen);
                    byte[] metaPayload = normalizeMetaPayload(meta.payload);
                    int oldMetaBoxSize = meta.encodedSize();
                    // Best-effort: clean up Exif item refs from meta tables.
                    try {
                        MetaTables tables = parseMetaTables(metaPayload);
                        int exifItemId = findExifItemId(tables.iinfPayload);
                        if (exifItemId >= 0) {
                            byte[] newIloc = removeIlocEntry(tables.ilocPayload, exifItemId);
                            byte[] newIinf = removeIinfEntry(tables.iinfPayload, exifItemId);
                            byte[] newIref = removeCdscRefs(tables.irefPayload, exifItemId);
                            byte[] tempMetaPayload =
                                    rebuildMeta(metaPayload, newIloc, newIinf, newIref);
                            int metaDelta =
                                    new BmffBox("meta", tempMetaPayload).encodedSize()
                                            - oldMetaBoxSize;
                            newIloc = shiftIlocExtentOffsets(newIloc, metaDelta);
                            metaPayload = rebuildMeta(metaPayload, newIloc, newIinf, newIref);
                        }
                    } catch (IOException ignored) {
                    }
                    ByteArrayOutputStream out = new ByteArrayOutputStream(avif.length);
                    ftyp.writeTo(out);
                    new BmffBox("meta", metaPayload).writeTo(out);
                    for (BmffBox other : top) {
                        if (!"ftyp".equals(other.type)
                                && !"meta".equals(other.type)
                                && !"mdat".equals(other.type)) {
                            other.writeTo(out);
                        }
                    }
                    new BmffBox("mdat", newMdatPayload).writeTo(out);
                    return out.toByteArray();
                }
                return avif;
            }
            fileOffset += 8 + box.payload.length;
        }
        return avif;
    }

    private static byte[] stripUsingMetaTables(byte[] avif) throws IOException {
        List<BmffBox> top = parseTopLevel(avif);
        BmffBox ftyp = require(top, "ftyp");
        BmffBox meta = require(top, "meta");
        BmffBox mdat = require(top, "mdat");

        byte[] metaPayload = normalizeMetaPayload(meta.payload);
        MetaTables tables = parseMetaTables(metaPayload);
        int exifItemId = findExifItemId(tables.iinfPayload);
        if (exifItemId < 0) {
            return avif;
        }

        int exifLength = ilocItemLength(tables.ilocPayload, exifItemId);
        if (exifLength <= 0 || mdat.payload.length < exifLength) {
            return avif;
        }

        int mdatPayloadStart = locateMdatPayloadStart(avif);
        int exifFileOffset = ilocItemOffset(tables.ilocPayload, exifItemId);
        int exifOffsetInMdat = exifFileOffset - mdatPayloadStart;
        int newMdatPayloadLength;
        if (exifOffsetInMdat >= 0 && exifOffsetInMdat + exifLength == mdat.payload.length) {
            newMdatPayloadLength = exifOffsetInMdat;
        } else if (mdat.payload.length >= exifLength) {
            newMdatPayloadLength = mdat.payload.length - exifLength;
        } else {
            return avif;
        }
        byte[] newMdatPayload = Arrays.copyOf(mdat.payload, newMdatPayloadLength);

        byte[] newIloc = removeIlocEntry(tables.ilocPayload, exifItemId);
        byte[] newIinf = removeIinfEntry(tables.iinfPayload, exifItemId);
        byte[] newIref = removeCdscRefs(tables.irefPayload, exifItemId);
        byte[] tempMetaPayload = rebuildMeta(metaPayload, newIloc, newIinf, newIref);
        int metaDelta = new BmffBox("meta", tempMetaPayload).encodedSize() - meta.encodedSize();
        newIloc = shiftIlocExtentOffsets(newIloc, metaDelta);
        byte[] newMetaPayload = rebuildMeta(metaPayload, newIloc, newIinf, newIref);

        ByteArrayOutputStream out = new ByteArrayOutputStream(avif.length);
        ftyp.writeTo(out);
        new BmffBox("meta", newMetaPayload).writeTo(out);
        for (BmffBox box : top) {
            if (!"ftyp".equals(box.type) && !"meta".equals(box.type) && !"mdat".equals(box.type)) {
                box.writeTo(out);
            }
        }
        new BmffBox("mdat", newMdatPayload).writeTo(out);
        return out.toByteArray();
    }

    private static int lastExifMarkerOffset(byte[] data) {
        byte[] marker = new byte[] {'E', 'x', 'i', 'f', 0, 0};
        int last = -1;
        outer:
        for (int i = 0; i <= data.length - marker.length; i++) {
            for (int j = 0; j < marker.length; j++) {
                if (data[i + j] != marker[j]) {
                    continue outer;
                }
            }
            last = i;
        }
        return last;
    }

    /** Older injector builds accidentally nested a full meta box inside meta payload. */
    private static byte[] normalizeMetaPayload(byte[] metaPayload) {
        if (metaPayload.length >= 8) {
            String type = new String(metaPayload, 4, 4, StandardCharsets.ISO_8859_1);
            if ("meta".equals(type)) {
                int innerSize = u32(metaPayload, 0);
                if (innerSize >= 8 && innerSize <= metaPayload.length) {
                    return Arrays.copyOfRange(metaPayload, 8, innerSize);
                }
            }
        }
        return metaPayload;
    }

    private static int findExifItemId(byte[] iinfPayload) {
        int offset = 6;
        while (offset + 8 <= iinfPayload.length) {
            int size = u32(iinfPayload, offset);
            if (size < 8 || offset + size > iinfPayload.length) {
                break;
            }
            String type = new String(iinfPayload, offset + 4, 4, StandardCharsets.ISO_8859_1);
            if ("infe".equals(type) && size >= 21) {
                int version = iinfPayload[offset + 8] & 0xFF;
                int id =
                        version >= 3
                                ? ByteBuffer.wrap(iinfPayload, offset + 12, 4)
                                        .order(ByteOrder.BIG_ENDIAN)
                                        .getInt()
                                : u16(iinfPayload, offset + 12);
                if (offset + 16 + 4 <= iinfPayload.length) {
                    String itemType =
                            new String(iinfPayload, offset + 16, 4, StandardCharsets.ISO_8859_1);
                    if ("Exif".equals(itemType)) {
                        return id;
                    }
                }
            }
            offset += size;
        }
        return -1;
    }

    private static int locateMdatPayloadStart(byte[] file) throws IOException {
        int offset = 0;
        for (BmffBox box : parseTopLevel(file)) {
            if ("mdat".equals(box.type)) {
                return offset + 8;
            }
            offset += 8 + box.payload.length;
        }
        throw new IOException("mdat missing");
    }

    private static int ilocItemOffset(byte[] ilocPayload, int itemId) throws IOException {
        IlocLayout layout = parseIlocLayout(ilocPayload);
        int itemCount = u16(ilocPayload, 6);
        ByteBuffer buf = ByteBuffer.wrap(ilocPayload).order(ByteOrder.BIG_ENDIAN);
        buf.position(8);
        for (int i = 0; i < itemCount; i++) {
            int id = buf.getShort() & 0xFFFF;
            buf.getShort();
            skipSized(buf, layout.baseOffsetSize);
            int extentCount = buf.getShort() & 0xFFFF;
            if (extentCount < 1) {
                continue;
            }
            int offset = readSized(buf, layout.offsetSize);
            skipSized(buf, layout.lengthSize);
            for (int e = 1; e < extentCount; e++) {
                skipSized(buf, layout.offsetSize);
                skipSized(buf, layout.lengthSize);
            }
            if (id == itemId) {
                return offset;
            }
        }
        return -1;
    }

    private static byte[] shiftIlocExtentOffsets(byte[] ilocPayload, int delta) throws IOException {
        if (delta == 0) {
            return ilocPayload;
        }
        byte[] copy = Arrays.copyOf(ilocPayload, ilocPayload.length);
        IlocLayout layout = parseIlocLayout(copy);
        ByteBuffer buf = ByteBuffer.wrap(copy).order(ByteOrder.BIG_ENDIAN);
        int itemCount = u16(copy, 6);
        buf.position(8);
        for (int i = 0; i < itemCount; i++) {
            buf.getShort();
            buf.getShort();
            skipSized(buf, layout.baseOffsetSize);
            int extentCount = buf.getShort() & 0xFFFF;
            for (int e = 0; e < extentCount; e++) {
                int offset = readSized(buf, layout.offsetSize);
                int length = readSized(buf, layout.lengthSize);
                buf.position(buf.position() - layout.offsetSize - layout.lengthSize);
                writeSized(buf, offset + delta, layout.offsetSize);
                writeSized(buf, length, layout.lengthSize);
            }
        }
        return copy;
    }

    private static void writeSized(ByteBuffer buf, int value, int bytes) throws IOException {
        switch (bytes) {
            case 0:
                break;
            case 4:
                buf.putInt(value);
                break;
            default:
                throw new IOException("unsupported iloc field size " + bytes);
        }
    }

    private static int ilocItemLength(byte[] ilocPayload, int itemId) throws IOException {
        IlocLayout layout = parseIlocLayout(ilocPayload);
        int itemCount = u16(ilocPayload, 6);
        ByteBuffer buf = ByteBuffer.wrap(ilocPayload).order(ByteOrder.BIG_ENDIAN);
        buf.position(8);
        for (int i = 0; i < itemCount; i++) {
            int id = buf.getShort() & 0xFFFF;
            buf.getShort();
            skipSized(buf, layout.baseOffsetSize);
            int extentCount = buf.getShort() & 0xFFFF;
            int totalLength = 0;
            for (int e = 0; e < extentCount; e++) {
                skipSized(buf, layout.offsetSize);
                totalLength += readSized(buf, layout.lengthSize);
            }
            if (id == itemId) {
                return totalLength;
            }
        }
        return -1;
    }

    private static byte[] removeIlocEntry(byte[] ilocPayload, int removeId) throws IOException {
        IlocLayout layout = parseIlocLayout(ilocPayload);
        int itemCount = u16(ilocPayload, 6);
        ByteBuffer buf = ByteBuffer.wrap(ilocPayload).order(ByteOrder.BIG_ENDIAN);
        buf.position(8);
        ByteArrayOutputStream kept = new ByteArrayOutputStream(ilocPayload.length);
        int keptCount = 0;
        for (int i = 0; i < itemCount; i++) {
            int start = buf.position();
            int id = buf.getShort() & 0xFFFF;
            buf.getShort();
            skipSized(buf, layout.baseOffsetSize);
            int extentCount = buf.getShort() & 0xFFFF;
            for (int e = 0; e < extentCount; e++) {
                skipSized(buf, layout.offsetSize);
                skipSized(buf, layout.lengthSize);
            }
            int end = buf.position();
            if (id != removeId) {
                kept.write(ilocPayload, start, end - start);
                keptCount++;
            }
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream(ilocPayload.length);
        out.write(ilocPayload, 0, 6);
        writeU16(out, keptCount);
        kept.writeTo(out);
        return out.toByteArray();
    }

    private static byte[] removeIinfEntry(byte[] iinfPayload, int removeId) throws IOException {
        ByteArrayOutputStream entries = new ByteArrayOutputStream(iinfPayload.length);
        int kept = 0;
        int offset = 6;
        while (offset + 8 <= iinfPayload.length) {
            int size = u32(iinfPayload, offset);
            if (size < 8 || offset + size > iinfPayload.length) {
                break;
            }
            boolean drop = false;
            if ("infe".equals(new String(iinfPayload, offset + 4, 4, StandardCharsets.ISO_8859_1))
                    && size >= 20) {
                int version = iinfPayload[offset + 8] & 0xFF;
                int id =
                        version >= 3
                                ? ByteBuffer.wrap(iinfPayload, offset + 12, 4)
                                        .order(ByteOrder.BIG_ENDIAN)
                                        .getInt()
                                : u16(iinfPayload, offset + 12);
                if (id == removeId) {
                    drop = true;
                }
            }
            if (!drop) {
                entries.write(iinfPayload, offset, size);
                kept++;
            }
            offset += size;
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream(iinfPayload.length);
        out.write(iinfPayload, 0, 4);
        writeU16(out, kept);
        entries.writeTo(out);
        return out.toByteArray();
    }

    private static byte[] removeCdscRefs(byte[] irefPayload, int exifItemId) throws IOException {
        ByteArrayOutputStream body = new ByteArrayOutputStream(irefPayload.length);
        body.write(irefPayload, 0, 4);
        int offset = 4;
        while (offset + 8 <= irefPayload.length) {
            int size = u32(irefPayload, offset);
            if (size < 8 || offset + size > irefPayload.length) {
                break;
            }
            String type = new String(irefPayload, offset + 4, 4, StandardCharsets.ISO_8859_1);
            if ("cdsc".equals(type) && size >= 14) {
                int fromId = u16(irefPayload, offset + 8);
                if (fromId != exifItemId) {
                    body.write(irefPayload, offset, size);
                }
            } else {
                body.write(irefPayload, offset, size);
            }
            offset += size;
        }
        return body.toByteArray();
    }

    private static byte[] rebuildMeta(byte[] metaPayload, byte[] iloc, byte[] iinf, byte[] iref)
            throws IOException {
        ByteArrayOutputStream result = new ByteArrayOutputStream(metaPayload.length + 64);
        result.write(metaPayload, 0, Math.min(4, metaPayload.length));
        for (BmffBox child : parseMetaChildren(metaPayload)) {
            byte[] payload;
            switch (child.type) {
                case "iloc":
                    payload = iloc;
                    break;
                case "iinf":
                    payload = iinf;
                    break;
                case "iref":
                    payload = iref;
                    break;
                default:
                    payload = child.payload;
                    break;
            }
            new BmffBox(child.type, payload).writeTo(result);
        }
        return result.toByteArray();
    }

    private static MetaTables parseMetaTables(byte[] metaPayload) throws IOException {
        MetaTables tables = new MetaTables();
        for (BmffBox child : parseMetaChildren(metaPayload)) {
            switch (child.type) {
                case "iloc":
                    tables.ilocPayload = child.payload;
                    break;
                case "iinf":
                    tables.iinfPayload = child.payload;
                    break;
                case "iref":
                    tables.irefPayload = child.payload;
                    break;
                default:
                    break;
            }
        }
        if (tables.ilocPayload == null || tables.iinfPayload == null || tables.irefPayload == null) {
            throw new IOException("meta missing iloc/iinf/iref");
        }
        return tables;
    }

    private static IlocLayout parseIlocLayout(byte[] ilocPayload) throws IOException {
        if (ilocPayload.length < 10) {
            throw new IOException("iloc too small");
        }
        IlocLayout layout = new IlocLayout();
        layout.offsetSize = (ilocPayload[4] >> 4) & 0xF;
        layout.lengthSize = ilocPayload[4] & 0xF;
        layout.baseOffsetSize = (ilocPayload[5] >> 4) & 0xF;
        if (layout.offsetSize != 4 || layout.lengthSize != 4) {
            throw new IOException("Unexpected iloc field sizes");
        }
        return layout;
    }

    private static void skipSized(ByteBuffer buf, int bytes) {
        buf.position(buf.position() + bytes);
    }

    private static int readSized(ByteBuffer buf, int bytes) throws IOException {
        switch (bytes) {
            case 0:
                return 0;
            case 4:
                return buf.getInt();
            default:
                throw new IOException("unsupported iloc field size " + bytes);
        }
    }

    private static List<BmffBox> parseMetaChildren(byte[] metaPayload) {
        if (metaPayload.length < 4) {
            return List.of();
        }
        try {
            return parseChildBoxes(metaPayload, 4, metaPayload.length);
        } catch (IOException e) {
            return List.of();
        }
    }

    private static List<BmffBox> parseTopLevel(byte[] data) throws IOException {
        return parseChildBoxes(data, 0, data.length);
    }

    private static List<BmffBox> parseChildBoxes(byte[] data, int start, int end) throws IOException {
        List<BmffBox> boxes = new ArrayList<>();
        int offset = start;
        while (offset + 8 <= end) {
            int size = u32(data, offset);
            String type = new String(data, offset + 4, 4, StandardCharsets.ISO_8859_1);
            int header = 8;
            if (size == 1) {
                if (offset + 16 > end) {
                    break;
                }
                size = (int) ByteBuffer.wrap(data, offset + 8, 8).order(ByteOrder.BIG_ENDIAN).getLong();
                header = 16;
            } else if (size == 0) {
                size = end - offset;
            }
            if (size < header || offset + size > end) {
                throw new IOException("Invalid box " + type + " size=" + size + " @" + offset);
            }
            byte[] payload = Arrays.copyOfRange(data, offset + header, offset + size);
            boxes.add(new BmffBox(type, payload));
            offset += size;
        }
        return boxes;
    }

    private static BmffBox require(List<BmffBox> boxes, String type) throws IOException {
        for (BmffBox box : boxes) {
            if (type.equals(box.type)) {
                return box;
            }
        }
        throw new IOException("Missing box " + type);
    }

    private static int u16(byte[] data, int offset) {
        return ((data[offset] & 0xFF) << 8) | (data[offset + 1] & 0xFF);
    }

    private static int u32(byte[] data, int offset) {
        return ((data[offset] & 0xFF) << 24)
                | ((data[offset + 1] & 0xFF) << 16)
                | ((data[offset + 2] & 0xFF) << 8)
                | (data[offset + 3] & 0xFF);
    }

    private static void writeU16(ByteArrayOutputStream out, int value) throws IOException {
        out.write((value >> 8) & 0xFF);
        out.write(value & 0xFF);
    }

    private static final class IlocLayout {
        int offsetSize;
        int lengthSize;
        int baseOffsetSize;
    }

    private static final class MetaTables {
        byte[] ilocPayload;
        byte[] iinfPayload;
        byte[] irefPayload;
    }

    private static final class BmffBox {
        final String type;
        final byte[] payload;

        BmffBox(String type, byte[] payload) {
            this.type = type;
            this.payload = payload;
        }

        int encodedSize() {
            return 8 + payload.length;
        }

        void writeTo(ByteArrayOutputStream out) throws IOException {
            int total = 8 + payload.length;
            ByteBuffer hdr = ByteBuffer.allocate(8).order(ByteOrder.BIG_ENDIAN);
            hdr.putInt(total);
            hdr.put(type.getBytes(StandardCharsets.ISO_8859_1), 0, 4);
            out.write(hdr.array());
            out.write(payload);
        }
    }
}
