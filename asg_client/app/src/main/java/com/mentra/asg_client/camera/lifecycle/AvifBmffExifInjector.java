package com.mentra.asg_client.camera.lifecycle;

import android.util.Log;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Embeds TIFF EXIF ({@code Exif\0\0} + IFD) into HeifCoder/libavif AVIF by extending {@code mdat}
 * and patching {@code iloc}/{@code iinf}/{@code iref}. Matches the layout produced by libheif on
 * Mentra Live so {@link android.media.MediaMetadataRetriever} exposes EXIF offset/length on API
 * 31+.
 */
final class AvifBmffExifInjector {
    private static final String TAG = "AvifBmffExif";

    private AvifBmffExifInjector() {}

    static void logBoxTree(byte[] data, String logTag) {
        try {
            for (BmffBox box : parseTopLevel(data)) {
                logBox(logTag, box, 0);
            }
        } catch (IOException e) {
            Log.w(logTag, "logBoxTree failed", e);
        }
    }

    private static void logBox(String logTag, BmffBox box, int depth) {
        String indent = "  ".repeat(Math.max(0, depth));
        Log.i(logTag, indent + "type=" + box.type + " payload=" + box.payload.length);
        if ("meta".equals(box.type)) {
            for (BmffBox child : parseMetaChildren(box.payload)) {
                logBox(logTag, child, depth + 1);
            }
        }
    }

    /**
     * @param exifTiffBlock bytes starting with {@code Exif\0\0} (no JPEG APP1 wrapper)
     */
    static byte[] injectExif(byte[] avif, byte[] exifTiffBlock) throws IOException {
        if (exifTiffBlock.length < 6
                || exifTiffBlock[0] != 'E'
                || exifTiffBlock[1] != 'x'
                || exifTiffBlock[2] != 'i'
                || exifTiffBlock[3] != 'f') {
            throw new IOException("EXIF block must start with Exif\\0\\0");
        }

        List<BmffBox> top = parseTopLevel(avif);
        BmffBox ftyp = require(top, "ftyp");
        BmffBox meta = require(top, "meta");
        BmffBox mdat = require(top, "mdat");

        byte[] metaPayload = normalizeMetaPayload(meta.payload);
        MetaTables tables = parseMetaTables(metaPayload);
        int exifItemId = tables.maxItemId + 1;

        byte[] newMdatPayload = concat(mdat.payload, exifTiffBlock);

        byte[] newIinf = appendIinfEntry(tables.iinfPayload, exifItemId);
        byte[] irefBase = tables.irefPayload != null ? tables.irefPayload : emptyIrefPayload();
        byte[] newIref = appendCdscRef(irefBase, exifItemId, tables.primaryItemId);
        // Meta grows before mdat; iloc v0 extent offsets are absolute file positions.
        byte[] tempIloc = appendIlocEntry(tables.ilocPayload, exifItemId, 0, exifTiffBlock.length);
        byte[] tempMetaPayload = rebuildMeta(metaPayload, tempIloc, newIinf, newIref);
        int metaDelta = new BmffBox("meta", tempMetaPayload).encodedSize() - meta.encodedSize();
        byte[] shiftedIloc = shiftIlocExtentOffsets(tables.ilocPayload, metaDelta);
        int exifOffsetInFile =
                ftyp.encodedSize()
                        + new BmffBox("meta", tempMetaPayload).encodedSize()
                        + mdat.headerSize()
                        + mdat.payload.length;
        byte[] newIloc =
                appendIlocEntry(shiftedIloc, exifItemId, exifOffsetInFile, exifTiffBlock.length);
        byte[] newMetaPayload = rebuildMeta(metaPayload, newIloc, newIinf, newIref);
        BmffBox newMeta = new BmffBox("meta", newMetaPayload);
        BmffBox newMdat = new BmffBox("mdat", newMdatPayload);

        ByteArrayOutputStream out =
                new ByteArrayOutputStream(avif.length + exifTiffBlock.length + 256);
        ftyp.writeTo(out);
        newMeta.writeTo(out);
        for (BmffBox box : top) {
            if (!"ftyp".equals(box.type) && !"meta".equals(box.type) && !"mdat".equals(box.type)) {
                box.writeTo(out);
            }
        }
        newMdat.writeTo(out);
        byte[] result = out.toByteArray();

        int actualExifOffset = locateMdatPayloadEnd(result) - exifTiffBlock.length;
        if (actualExifOffset != exifOffsetInFile) {
            Log.d(
                    TAG,
                    "Re-patching iloc exif offset " + exifOffsetInFile + " -> " + actualExifOffset);
            MetaTables reparsed = parseMetaTables(newMetaPayload);
            byte[] patchedIloc =
                    patchIlocEntryOffset(
                            reparsed.ilocPayload,
                            exifItemId,
                            actualExifOffset,
                            exifTiffBlock.length);
            byte[] patchedMeta = rebuildMeta(newMetaPayload, patchedIloc, newIinf, newIref);
            System.arraycopy(
                    new BmffBox("meta", patchedMeta).encode(),
                    0,
                    result,
                    ftyp.encodedSize(),
                    new BmffBox("meta", patchedMeta).encodedSize());
        }

        Log.d(
                TAG,
                "Injected EXIF item "
                        + exifItemId
                        + " at offset "
                        + actualExifOffset
                        + " ("
                        + exifTiffBlock.length
                        + " bytes), file "
                        + result.length
                        + " bytes");
        return result;
    }

    /** Unwrap accidental nested {@code meta} box left by older injector builds. */
    private static byte[] normalizeMetaPayload(byte[] metaPayload) {
        if (metaPayload.length >= 8) {
            String type =
                    new String(metaPayload, 4, 4, java.nio.charset.StandardCharsets.ISO_8859_1);
            if ("meta".equals(type)) {
                int innerSize = u32(metaPayload, 0);
                if (innerSize >= 8 && innerSize <= metaPayload.length) {
                    return Arrays.copyOfRange(metaPayload, 8, innerSize);
                }
            }
        }
        return metaPayload;
    }

    private static int locateMdatPayloadEnd(byte[] file) throws IOException {
        int offset = 0;
        for (BmffBox box : parseTopLevel(file)) {
            if ("mdat".equals(box.type)) {
                return offset + box.headerSize() + box.payload.length;
            }
            offset += box.encodedSize();
        }
        throw new IOException("mdat missing");
    }

    /**
     * Returns the meta box PAYLOAD (version+flags + rebuilt child boxes). Callers wrap this in a
     * BmffBox("meta", ...) which adds the 8-byte box header.
     */
    private static byte[] rebuildMeta(byte[] metaPayload, byte[] iloc, byte[] iinf, byte[] iref)
            throws IOException {
        ByteArrayOutputStream result = new ByteArrayOutputStream(metaPayload.length + 128);
        // Preserve original version+flags (4 bytes at start of meta payload)
        result.write(metaPayload, 0, Math.min(4, metaPayload.length));
        List<BmffBox> children = parseMetaChildren(metaPayload);
        boolean hadIref = false;
        for (BmffBox child : children) {
            if ("iref".equals(child.type)) {
                hadIref = true;
                break;
            }
        }
        boolean insertedIref = false;
        for (BmffBox child : children) {
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
            if ("iinf".equals(child.type) && !hadIref && iref != null) {
                new BmffBox("iref", iref).writeTo(result);
                insertedIref = true;
            }
        }
        if (!hadIref && !insertedIref && iref != null) {
            new BmffBox("iref", iref).writeTo(result);
        }
        return result.toByteArray();
    }

    /** Empty iref box payload (version 0 + flags) for AVIF files that omit optional iref. */
    private static byte[] emptyIrefPayload() {
        return new byte[] {0, 0, 0, 0};
    }

    private static byte[] appendIlocEntry(byte[] ilocPayload, int itemId, int offset, int length)
            throws IOException {
        if (ilocPayload.length < 12) {
            throw new IOException("iloc too small");
        }
        int version = ilocPayload[0] & 0xFF;
        if (version != 0) {
            throw new IOException("Unsupported iloc version " + version);
        }
        IlocLayout layout = parseIlocLayout(ilocPayload);
        // iloc payload: [0..3]=version+flags [4..5]=field_sizes [6..7]=item_count [8+]=items
        int itemCount = u16(ilocPayload, 6);
        byte[] existing = Arrays.copyOfRange(ilocPayload, 8, ilocPayload.length);

        ByteArrayOutputStream out = new ByteArrayOutputStream(ilocPayload.length + 24);
        out.write(ilocPayload, 0, 6); // version+flags + field_sizes only (not item_count)
        writeU16(out, itemCount + 1);
        out.write(existing);
        writeIlocItem(out, layout, itemId, offset, length);
        return out.toByteArray();
    }

    /**
     * Shifts absolute iloc extent offsets when boxes before {@code mdat} grow (e.g. larger meta).
     */
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

    private static int readSized(ByteBuffer buf, int bytes) {
        switch (bytes) {
            case 0:
                return 0;
            case 4:
                return buf.getInt();
            default:
                throw new IllegalArgumentException("unsupported size " + bytes);
        }
    }

    private static byte[] patchIlocEntryOffset(
            byte[] ilocPayload, int itemId, int offset, int length) throws IOException {
        IlocLayout layout = parseIlocLayout(ilocPayload);
        ByteBuffer buf = ByteBuffer.wrap(ilocPayload).order(ByteOrder.BIG_ENDIAN);
        buf.position(8); // items start at byte 8
        int itemCount = u16(ilocPayload, 6); // item_count at byte 6
        for (int i = 0; i < itemCount; i++) {
            int id = buf.getShort() & 0xFFFF;
            buf.getShort();
            skipSized(buf, layout.baseOffsetSize);
            int extentCount = buf.getShort() & 0xFFFF;
            for (int e = 0; e < extentCount; e++) {
                if (id == itemId) {
                    writeSized(buf, offset, layout.offsetSize);
                    writeSized(buf, length, layout.lengthSize);
                    return ilocPayload;
                }
                skipSized(buf, layout.offsetSize);
                skipSized(buf, layout.lengthSize);
            }
        }
        throw new IOException("iloc item " + itemId + " not found");
    }

    private static void writeIlocItem(
            ByteArrayOutputStream out, IlocLayout layout, int itemId, int offset, int length)
            throws IOException {
        writeU16(out, itemId);
        writeU16(out, 0);
        writeSized(out, 0, layout.baseOffsetSize);
        writeU16(out, 1);
        writeSized(out, offset, layout.offsetSize);
        writeSized(out, length, layout.lengthSize);
    }

    private static IlocLayout parseIlocLayout(byte[] ilocPayload) throws IOException {
        if (ilocPayload.length < 10) {
            throw new IOException("iloc too small");
        }
        int version = ilocPayload[0] & 0xFF;
        if (version != 0) {
            throw new IOException("Unsupported iloc version " + version);
        }
        IlocLayout layout = new IlocLayout();
        layout.offsetSize = (ilocPayload[4] >> 4) & 0xF;
        layout.lengthSize = ilocPayload[4] & 0xF;
        layout.baseOffsetSize = (ilocPayload[5] >> 4) & 0xF;
        layout.indexSize = ilocPayload[5] & 0xF;
        if (layout.offsetSize != 4 || layout.lengthSize != 4) {
            throw new IOException("Unexpected iloc offset/length field sizes");
        }
        return layout;
    }

    private static void skipSized(ByteBuffer buf, int bytes) {
        buf.position(buf.position() + bytes);
    }

    private static void writeSized(ByteBuffer buf, int value, int bytes) {
        switch (bytes) {
            case 0:
                break;
            case 4:
                buf.putInt(value);
                break;
            default:
                throw new IllegalArgumentException("unsupported size " + bytes);
        }
    }

    private static void writeSized(ByteArrayOutputStream out, int value, int bytes)
            throws IOException {
        switch (bytes) {
            case 0:
                break;
            case 4:
                writeU32(out, value);
                break;
            default:
                throw new IllegalArgumentException("unsupported size " + bytes);
        }
    }

    private static byte[] appendIinfEntry(byte[] iinfPayload, int itemId) throws IOException {
        if (iinfPayload.length < 6) {
            throw new IOException("iinf too small");
        }
        // iinf payload: [0..3]=version+flags [4..5]=entry_count [6+]=entries
        int entryCount = u16(iinfPayload, 4);
        byte[] entries = Arrays.copyOfRange(iinfPayload, 6, iinfPayload.length);
        ByteArrayOutputStream body = new ByteArrayOutputStream(iinfPayload.length + 32);
        body.write(iinfPayload, 0, 4);
        writeU16(body, entryCount + 1);
        body.write(entries);
        body.write(buildInfeV2(itemId, "Exif"));
        return body.toByteArray();
    }

    private static byte[] buildInfeV2(int itemId, String itemType) {
        ByteBuffer buf = ByteBuffer.allocate(21).order(ByteOrder.BIG_ENDIAN);
        buf.putInt(21);
        buf.put((byte) 'i');
        buf.put((byte) 'n');
        buf.put((byte) 'f');
        buf.put((byte) 'e');
        buf.put((byte) 2);
        buf.put((byte) 0);
        buf.put((byte) 0);
        buf.put((byte) 0);
        buf.putShort((short) itemId);
        buf.putShort((short) 0);
        for (int i = 0; i < 4; i++) {
            buf.put((byte) itemType.charAt(i));
        }
        buf.put((byte) 0);
        return buf.array();
    }

    private static byte[] appendCdscRef(byte[] irefPayload, int exifItemId, int primaryItemId)
            throws IOException {
        ByteArrayOutputStream body = new ByteArrayOutputStream(irefPayload.length + 24);
        body.write(irefPayload, 0, 4); // version+flags
        body.write(irefPayload, 4, irefPayload.length - 4);
        body.write(buildCdscRefV0(exifItemId, primaryItemId));
        return body.toByteArray();
    }

    private static byte[] buildCdscRefV0(int fromItemId, int toItemId) {
        // cdsc single-item reference box (version 0):
        // size(4) type(4) from_item_ID(2) reference_count(2) to_item_ID(2) = 14 bytes
        ByteBuffer buf = ByteBuffer.allocate(14).order(ByteOrder.BIG_ENDIAN);
        buf.putInt(14);
        buf.put((byte) 'c');
        buf.put((byte) 'd');
        buf.put((byte) 's');
        buf.put((byte) 'c');
        buf.putShort((short) fromItemId);
        buf.putShort((short) 1); // reference_count
        buf.putShort((short) toItemId);
        return buf.array();
    }

    private static MetaTables parseMetaTables(byte[] metaPayload) throws IOException {
        MetaTables tables = new MetaTables();
        for (BmffBox child : parseMetaChildren(metaPayload)) {
            switch (child.type) {
                case "pitm":
                    tables.primaryItemId = readPitmItemId(child.payload);
                    break;
                case "iloc":
                    tables.ilocPayload = child.payload;
                    tables.maxItemId = Math.max(tables.maxItemId, maxItemIdFromIloc(child.payload));
                    break;
                case "iinf":
                    tables.iinfPayload = child.payload;
                    tables.maxItemId = Math.max(tables.maxItemId, maxItemIdFromIinf(child.payload));
                    break;
                case "iref":
                    tables.irefPayload = child.payload;
                    break;
                default:
                    break;
            }
        }
        if (tables.primaryItemId <= 0) {
            tables.primaryItemId = 1;
        }
        if (tables.maxItemId <= 0) {
            tables.maxItemId = tables.primaryItemId;
        }
        if (tables.ilocPayload == null || tables.iinfPayload == null) {
            throw new IOException("meta missing iloc/iinf");
        }
        return tables;
    }

    private static int readPitmItemId(byte[] payload) {
        if (payload.length < 6) {
            return 1;
        }
        int version = payload[0] & 0xFF;
        if (version == 0) {
            return u16(payload, 4);
        }
        return ByteBuffer.wrap(payload).order(ByteOrder.BIG_ENDIAN).getInt(4);
    }

    private static int maxItemIdFromIloc(byte[] payload) throws IOException {
        if (payload.length < 10) {
            return 0;
        }
        IlocLayout layout = parseIlocLayout(payload);
        int count = u16(payload, 6); // item_count at byte 6
        ByteBuffer buf = ByteBuffer.wrap(payload).order(ByteOrder.BIG_ENDIAN);
        buf.position(8); // items start at byte 8
        int max = 0;
        for (int i = 0; i < count; i++) {
            int id = buf.getShort() & 0xFFFF;
            max = Math.max(max, id);
            buf.getShort();
            skipSized(buf, layout.baseOffsetSize);
            int extentCount = buf.getShort() & 0xFFFF;
            for (int e = 0; e < extentCount; e++) {
                skipSized(buf, layout.offsetSize);
                skipSized(buf, layout.lengthSize);
            }
        }
        return max;
    }

    private static int maxItemIdFromIinf(byte[] payload) {
        int max = 0;
        int offset = 6; // entries start at byte 6 (after version+flags[0..3] and entry_count[4..5])
        while (offset + 8 <= payload.length) {
            int size = u32(payload, offset);
            if (size < 8 || offset + size > payload.length) {
                break;
            }
            String type =
                    new String(
                            payload, offset + 4, 4, java.nio.charset.StandardCharsets.ISO_8859_1);
            if ("infe".equals(type) && size >= 15) {
                int version = payload[offset + 8] & 0xFF;
                int id =
                        version >= 3
                                ? ByteBuffer.wrap(payload, offset + 12, 4)
                                        .order(ByteOrder.BIG_ENDIAN)
                                        .getInt()
                                : u16(payload, offset + 12);
                max = Math.max(max, id);
            }
            offset += size;
        }
        return max;
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

    private static List<BmffBox> parseChildBoxes(byte[] data, int start, int end)
            throws IOException {
        List<BmffBox> boxes = new ArrayList<>();
        int offset = start;
        while (offset + 8 <= end) {
            int size = u32(data, offset);
            String type =
                    new String(data, offset + 4, 4, java.nio.charset.StandardCharsets.ISO_8859_1);
            int header = 8;
            if (size == 1) {
                if (offset + 16 > end) {
                    break;
                }
                size =
                        (int)
                                ByteBuffer.wrap(data, offset + 8, 8)
                                        .order(ByteOrder.BIG_ENDIAN)
                                        .getLong();
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

    private static void writeU32(ByteArrayOutputStream out, int value) throws IOException {
        out.write((value >> 24) & 0xFF);
        out.write((value >> 16) & 0xFF);
        out.write((value >> 8) & 0xFF);
        out.write(value & 0xFF);
    }

    private static byte[] concat(byte[] a, byte[] b) {
        byte[] out = Arrays.copyOf(a, a.length + b.length);
        System.arraycopy(b, 0, out, a.length, b.length);
        return out;
    }

    private static final class IlocLayout {
        int offsetSize;
        int lengthSize;
        int baseOffsetSize;
        int indexSize;
    }

    private static final class MetaTables {
        int primaryItemId = 1;
        int maxItemId;
        byte[] ilocPayload;
        byte[] iinfPayload;
        byte[] irefPayload;
    }

    static final class BmffBox {
        final String type;
        final byte[] payload;

        BmffBox(String type, byte[] payload) {
            this.type = type;
            this.payload = payload;
        }

        int headerSize() {
            return 8;
        }

        int encodedSize() {
            return 8 + payload.length;
        }

        byte[] encode() throws IOException {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            writeTo(out);
            return out.toByteArray();
        }

        void writeTo(ByteArrayOutputStream out) throws IOException {
            int total = 8 + payload.length;
            ByteBuffer hdr = ByteBuffer.allocate(8).order(ByteOrder.BIG_ENDIAN);
            hdr.putInt(total);
            hdr.put(type.getBytes(java.nio.charset.StandardCharsets.ISO_8859_1), 0, 4);
            out.write(hdr.array());
            out.write(payload);
        }
    }
}
