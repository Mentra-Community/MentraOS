package com.mentra.asg_client.io.server.services;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;

import org.junit.Test;

public class GalleryTransferProtocolTest {

    @Test
    public void parsesClosedAndOpenRanges() {
        GalleryTransferProtocol.ByteRange closed =
                GalleryTransferProtocol.parseRange("bytes=10-19", 100);
        assertEquals(10, closed.start);
        assertEquals(19, closed.end);
        assertEquals(10, closed.length());

        GalleryTransferProtocol.ByteRange open =
                GalleryTransferProtocol.parseRange("bytes=90-", 100);
        assertEquals(90, open.start);
        assertEquals(99, open.end);
    }

    @Test
    public void parsesSuffixAndClampsEnd() {
        GalleryTransferProtocol.ByteRange suffix =
                GalleryTransferProtocol.parseRange("bytes=-5", 100);
        assertEquals(95, suffix.start);
        assertEquals(99, suffix.end);

        GalleryTransferProtocol.ByteRange clamped =
                GalleryTransferProtocol.parseRange("bytes=90-200", 100);
        assertEquals(90, clamped.start);
        assertEquals(99, clamped.end);
    }

    @Test
    public void rejectsUnsatisfiableAndMultipleRanges() {
        assertThrows(
                IllegalArgumentException.class,
                () -> GalleryTransferProtocol.parseRange("bytes=100-", 100));
        assertThrows(
                IllegalArgumentException.class,
                () -> GalleryTransferProtocol.parseRange("bytes=0-1,4-5", 100));
        assertNull(GalleryTransferProtocol.parseRange(null, 100));
    }
}
