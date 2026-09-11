package com.mentra.asg_client.io.bluetooth.managers.mentralive.internal;

/**
 * Encodes and decodes the 2-byte length field of K900 {@code ##} STRING (0x30) frames.
 *
 * <p>Legacy BES firmware uses big-endian for this field; BLE Wire v2 clients use little-endian.
 * The two conventions are negotiated per link (see {@code wire_caps}); until a peer advertises
 * little-endian, callers should default to {@link Endian#BE}. On receive, {@link #detectLength}
 * heuristically recovers the endianness so we interoperate with peers of unknown vintage.
 *
 * <p>File-transfer header fields (packSize/packIndex/fileSize) are always big-endian and are not
 * handled here — see the file helpers in {@link BesWireFormat}.
 */
public final class K900LengthCodec {

    private K900LengthCodec() {}

    public enum Endian {
        BE,
        LE
    }

    /** Fixed K900 STRING framing overhead: {@code ## + type + len(2) + $$}. */
    public static final int FRAME_OVERHEAD = 7;

    /** Offset of the 2-byte length field within a K900 frame. */
    public static final int LENGTH_OFFSET = 3;

    /** Offset of the payload within a K900 frame. */
    public static final int PAYLOAD_OFFSET = 5;

    /** Maximum plausible STRING payload length (matches firmware buffer cap). */
    public static final int MAX_STRING_LENGTH = 512;

    public static int readLength(byte[] frame, int offset, Endian endian) {
        int b0 = frame[offset] & 0xFF;
        int b1 = frame[offset + 1] & 0xFF;
        return endian == Endian.LE ? (b0 | (b1 << 8)) : ((b0 << 8) | b1);
    }

    public static void writeLength(byte[] frame, int offset, int value, Endian endian) {
        if (endian == Endian.LE) {
            frame[offset] = (byte) (value & 0xFF);
            frame[offset + 1] = (byte) ((value >> 8) & 0xFF);
        } else {
            frame[offset] = (byte) ((value >> 8) & 0xFF);
            frame[offset + 1] = (byte) (value & 0xFF);
        }
    }

    /** Result of a heuristic endianness detection. */
    public static final class Detected {
        public final int length;
        public final Endian endian;

        Detected(int length, Endian endian) {
            this.length = length;
            this.endian = endian;
        }
    }

    /**
     * Heuristically determine the STRING length field's endianness for a received frame. Mirrors
     * the firmware's {@code k900_detect_string_length}: a length is plausible when it is non-zero,
     * within the cap, and the full framed command fits inside the buffer. When both interpretations
     * fit, prefer the one whose payload lands exactly on the trailing {@code $$}, then the smaller.
     *
     * @return the detected length + endianness, or {@code null} if neither interpretation is valid
     */
    public static Detected detectLength(byte[] frame) {
        if (frame == null || frame.length < FRAME_OVERHEAD) {
            return null;
        }

        int leLen = readLength(frame, LENGTH_OFFSET, Endian.LE);
        int beLen = readLength(frame, LENGTH_OFFSET, Endian.BE);

        boolean leOk = leLen > 0 && leLen <= MAX_STRING_LENGTH && leLen + FRAME_OVERHEAD <= frame.length;
        boolean beOk = beLen > 0 && beLen <= MAX_STRING_LENGTH && beLen + FRAME_OVERHEAD <= frame.length;

        if (leOk && beOk) {
            if (endsWithEndCode(frame, PAYLOAD_OFFSET + leLen)) {
                return new Detected(leLen, Endian.LE);
            }
            if (endsWithEndCode(frame, PAYLOAD_OFFSET + beLen)) {
                return new Detected(beLen, Endian.BE);
            }
            return leLen <= beLen ? new Detected(leLen, Endian.LE) : new Detected(beLen, Endian.BE);
        }
        if (leOk) {
            return new Detected(leLen, Endian.LE);
        }
        if (beOk) {
            return new Detected(beLen, Endian.BE);
        }
        return null;
    }

    private static boolean endsWithEndCode(byte[] frame, int endOffset) {
        return endOffset + 1 < frame.length
                && frame[endOffset] == BesWireFormat.CMD_END_CODE[0]
                && frame[endOffset + 1] == BesWireFormat.CMD_END_CODE[1];
    }

    /**
     * Transcode a K900 STRING frame's length bytes from one endianness to another, leaving the
     * payload untouched. Used by the ASG shim when it must bridge a phone and BES that disagree on
     * endianness. Returns a new array; the input is not modified.
     */
    public static byte[] repackStringFrame(byte[] frame, Endian from, Endian to) {
        if (frame == null || frame.length < FRAME_OVERHEAD) {
            return frame;
        }
        if (from == to) {
            return frame.clone();
        }
        byte[] out = frame.clone();
        int length = readLength(frame, LENGTH_OFFSET, from);
        writeLength(out, LENGTH_OFFSET, length, to);
        return out;
    }
}
