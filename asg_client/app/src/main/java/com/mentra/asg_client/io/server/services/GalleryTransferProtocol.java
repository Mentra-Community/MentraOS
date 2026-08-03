package com.mentra.asg_client.io.server.services;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/** Stateless helpers for reliable, resumable gallery transfers. */
final class GalleryTransferProtocol {

    private static final int STREAM_BUFFER_BYTES = 64 * 1024;

    private GalleryTransferProtocol() {}

    static final class ByteRange {
        final long start;
        final long end;

        ByteRange(long start, long end) {
            this.start = start;
            this.end = end;
        }

        long length() {
            return end - start + 1;
        }
    }

    /**
     * Parse one RFC 7233 byte range. Multiple ranges are deliberately rejected because gallery
     * clients download one immutable segment at a time.
     */
    static ByteRange parseRange(String header, long fileLength) {
        if (header == null || header.trim().isEmpty()) {
            return null;
        }
        if (fileLength <= 0 || !header.startsWith("bytes=") || header.indexOf(',') >= 0) {
            throw new IllegalArgumentException("Unsatisfiable byte range");
        }

        String value = header.substring("bytes=".length()).trim();
        int dash = value.indexOf('-');
        if (dash < 0 || value.indexOf('-', dash + 1) >= 0) {
            throw new IllegalArgumentException("Invalid byte range");
        }

        try {
            String startValue = value.substring(0, dash).trim();
            String endValue = value.substring(dash + 1).trim();
            long start;
            long end;

            if (startValue.isEmpty()) {
                long suffixLength = Long.parseLong(endValue);
                if (suffixLength <= 0) {
                    throw new IllegalArgumentException("Invalid suffix range");
                }
                start = Math.max(0, fileLength - suffixLength);
                end = fileLength - 1;
            } else {
                start = Long.parseLong(startValue);
                end = endValue.isEmpty() ? fileLength - 1 : Long.parseLong(endValue);
                if (start < 0 || start >= fileLength) {
                    throw new IllegalArgumentException("Range start is outside file");
                }
                end = Math.min(end, fileLength - 1);
                if (end < start) {
                    throw new IllegalArgumentException("Range end precedes start");
                }
            }
            return new ByteRange(start, end);
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException("Invalid byte range", e);
        }
    }

    /**
     * A cheap generation validator. It changes whenever the path, size, or modification time
     * changes; content integrity is checked separately with SHA-256.
     */
    static String createEtag(File file) {
        return createEtag(file.getName(), file.length(), file.lastModified());
    }

    static String createEtag(String name, long length, long lastModified) {
        return String.format(
                "\"%s-%x-%x\"", Integer.toHexString(name.hashCode()), length, lastModified);
    }

    static InputStream open(File file, long start, long length) throws IOException {
        FileInputStream stream = new FileInputStream(file);
        try {
            skipFully(stream, start);
            return new BoundedInputStream(
                    new BufferedInputStream(stream, STREAM_BUFFER_BYTES), length);
        } catch (IOException e) {
            stream.close();
            throw e;
        }
    }

    static String sha256(File file) throws IOException {
        MessageDigest digest;
        try {
            digest = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is unavailable", e);
        }

        byte[] buffer = new byte[STREAM_BUFFER_BYTES];
        try (InputStream input =
                new BufferedInputStream(new FileInputStream(file), STREAM_BUFFER_BYTES)) {
            int read;
            while ((read = input.read(buffer)) != -1) {
                digest.update(buffer, 0, read);
            }
        }

        StringBuilder result = new StringBuilder(64);
        for (byte value : digest.digest()) {
            result.append(String.format("%02x", value & 0xff));
        }
        return result.toString();
    }

    private static void skipFully(InputStream stream, long count) throws IOException {
        long remaining = count;
        while (remaining > 0) {
            long skipped = stream.skip(remaining);
            if (skipped > 0) {
                remaining -= skipped;
                continue;
            }
            if (stream.read() == -1) {
                throw new IOException("Unexpected end of file while seeking");
            }
            remaining--;
        }
    }

    private static final class BoundedInputStream extends FilterInputStream {
        private long remaining;

        BoundedInputStream(InputStream input, long remaining) {
            super(input);
            this.remaining = remaining;
        }

        @Override
        public int read() throws IOException {
            if (remaining == 0) {
                return -1;
            }
            int value = super.read();
            if (value != -1) {
                remaining--;
            }
            return value;
        }

        @Override
        public int read(byte[] buffer, int offset, int length) throws IOException {
            if (remaining == 0) {
                return -1;
            }
            int read = super.read(buffer, offset, (int) Math.min(length, remaining));
            if (read != -1) {
                remaining -= read;
            }
            return read;
        }
    }
}
