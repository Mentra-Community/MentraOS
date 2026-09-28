package com.mentra.asg_client.io.bes.log;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.robolectric.Shadows.shadowOf;

import android.content.Context;

import androidx.test.core.app.ApplicationProvider;

import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class BesTraceTailTest {
    private final List<String> mSent = new ArrayList<>();
    /** Stored line count when each frame was sent, to prove acks follow the disk write. */
    private final List<Integer> mStoredAtSend = new ArrayList<>();
    private BesTraceTail mTail;

    @Before
    public void setUp() {
        mTail = BesTraceTail.get();
        mTail.resetForTest();
        Context context = ApplicationProvider.getApplicationContext();
        deleteRecursively(new java.io.File(context.getFilesDir(), "bes_trace"));
        mTail.attach(context);
        mTail.setSender(json -> {
            mSent.add(json);
            mStoredAtSend.add(mTail.store().readSince(Long.MAX_VALUE / 4).size());
            return true;
        });
    }

    static void deleteRecursively(java.io.File file) {
        java.io.File[] children = file.listFiles();
        if (children != null) {
            for (java.io.File child : children) deleteRecursively(child);
        }
        file.delete();
    }

    @After
    public void tearDown() {
        mTail.resetForTest();
    }

    private void idle() {
        shadowOf(mTail.looper()).idle();
    }

    private static byte[] frame(String name, JSONObject body) throws Exception {
        return new JSONObject().put("C", name).put("B", body).toString().getBytes(StandardCharsets.UTF_8);
    }

    private static JSONObject data(long g, long p, long e, String text) throws Exception {
        return new JSONObject().put("g", g)
                .put("p", String.format(Locale.US, "%016x", p))
                .put("e", String.format(Locale.US, "%016x", e))
                .put("c", String.format(Locale.US, "%016x", p))
                .put("l", String.format(Locale.US, "%016x", 0))
                .put("n", text.getBytes(StandardCharsets.UTF_8).length)
                .put("t", 1000).put("tp", 1000).put("d", text);
    }

    private String last(String name) {
        for (int i = mSent.size() - 1; i >= 0; i--) {
            if (mSent.get(i).contains("\"C\":\"" + name + "\"")) return mSent.get(i);
        }
        return null;
    }

    @Test
    public void nothingIsSentUntilTheBesAdvertisesSupport() {
        idle();
        assertTrue(mSent.isEmpty());
        mTail.setSupported(true);
        idle();
        assertTrue(last("mh_rlog").contains("\\\"g\\\":0"));
    }

    @Test
    public void persistsBeforeAcknowledgingAndResumesFromTheCursor() throws Exception {
        mTail.setSupported(true);
        idle();
        assertTrue(mTail.onUartPayload(frame("hm_rlog", data(5, 0, 40, " 1000/I/NONE  / 6 | [PWR] a\n"))));
        idle();
        int ackIndex = mSent.indexOf(last("mh_rlog_ack"));
        assertTrue("ack sent", ackIndex >= 0);
        assertEquals("the line was on disk before the ack", 1, (int) mStoredAtSend.get(ackIndex));
        String ack = last("mh_rlog_ack");
        assertTrue(ack, ack.contains("000000000000001c"));
        BesTraceStore.Cursor cursor = mTail.store().loadCursor();
        assertEquals(5, cursor.generation);
        assertEquals(0x1c, cursor.position);
    }

    @Test
    public void readyWindowHoldsALeaseUntilCaughtUp() throws Exception {
        mTail.setSupported(true);
        idle();
        mTail.onUartPayload(frame("hm_rlog_ready",
                new JSONObject().put("g", 5).put("pending", 30000).put("reason", "fill")));
        idle();
        assertTrue(mTail.windowActive());
        assertTrue(mTail.leaseHeld());
        // Far behind: the window stays open and the next read follows quickly.
        mTail.onUartPayload(frame("hm_rlog", data(5, 0, 30000, "a\n")));
        idle();
        assertTrue(mTail.windowActive());
        mTail.onUartPayload(frame("hm_rlog", data(5, 2, 2, "")));
        idle();
        assertFalse(mTail.windowActive());
        assertFalse(mTail.leaseHeld());
        // Nothing new still acknowledges inside a window (the BES counts it as delivery).
        assertTrue(last("mh_rlog_ack").contains("0000000000000002"));
    }

    @Test
    public void statusFromReadyIsStoredForBugReports() throws Exception {
        mTail.setSupported(true);
        idle();
        mTail.onUartPayload(frame("hm_rlog_ready",
                new JSONObject().put("g", 5).put("rxovf", 0).put("skip", 3)));
        idle();
        List<BesTraceStore.Line> lines = mTail.store().readSince(Long.MAX_VALUE / 4);
        assertTrue(lines.get(lines.size() - 1).text.startsWith("[ASG-BES-STATUS] "));
        assertTrue(lines.get(lines.size() - 1).text.contains("\"skip\":3"));
    }

    @Test
    public void otherPayloadsAreNotConsumed() {
        assertFalse(mTail.onUartPayload("{\"C\":\"sr_syvr\",\"B\":{}}".getBytes(StandardCharsets.UTF_8)));
        assertFalse(mTail.onUartPayload(null));
    }

    @Test
    public void unsupportedFirmwareNeverServesIncidents() {
        assertFalse(mTail.canServeIncidents());
        mTail.setSupported(true);
        assertTrue(mTail.canServeIncidents());
        mTail.setSupported(false);
        assertFalse(mTail.canServeIncidents());
    }
}
