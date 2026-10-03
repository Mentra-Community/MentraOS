package com.mentra.asg_client.io.media.core;

import static org.junit.Assert.*;

import java.io.IOException;
import java.util.concurrent.CancellationException;
import java.util.concurrent.TimeoutException;
import org.junit.Test;

public class PhotoTransferAckTest {
    @Test
    public void encodingCanFinishBeforeAcknowledgement() throws Exception {
        PhotoTransferAck ack = new PhotoTransferAck(1000);
        assertFalse(ack.result.isDone());
        // CPU work is permitted before calling await; the transfer remains pending.
        assertTrue(ack.result.complete(true));
        ack.await();
    }

    @Test
    public void acknowledgementCanArriveBeforeEncodingFinishes() throws Exception {
        PhotoTransferAck ack = new PhotoTransferAck(0);
        ack.result.complete(true);
        ack.await();
        assertFalse(ack.result.complete(false));
    }

    @Test
    public void failedThumbnailDoesNotAuthorizeMainTransfer() {
        PhotoTransferAck ack = new PhotoTransferAck(1000);
        ack.result.complete(false);
        assertThrows(IOException.class, ack::await);
    }

    @Test
    public void expiredBudgetDoesNotRestartWhenEncodingFinishes() {
        PhotoTransferAck ack = new PhotoTransferAck(0);
        assertThrows(TimeoutException.class, ack::await);
    }

    @Test
    public void teardownUnblocksWait() {
        PhotoTransferAck ack = new PhotoTransferAck(1000);
        ack.result.cancel(false);
        assertThrows(CancellationException.class, ack::await);
    }
}
