package com.mentra.asg_client.io.bes.log;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;

import java.util.Locale;

@RunWith(RobolectricTestRunner.class)
public class BesTraceSessionTest {
    private static final long RECEIVED = 1_800_000_000_000L;

    private static JSONObject reply(long g, long p, long e, long lost, String data, long t, long tp)
            throws Exception {
        JSONObject body = new JSONObject();
        body.put("g", g);
        body.put("p", String.format(Locale.US, "%016x", p));
        body.put("e", String.format(Locale.US, "%016x", e));
        body.put("c", String.format(Locale.US, "%016x", p));
        body.put("l", String.format(Locale.US, "%016x", lost));
        body.put("n", data.getBytes("UTF-8").length);
        body.put("t", t);
        body.put("tp", tp);
        body.put("d", data);
        return body;
    }

    @Test
    public void firstRequestAsksTheBesToResumeFromItsCommit() {
        assertEquals("{\"g\":0,\"p\":\"0000000000000000\"}", new BesTraceSession().requestBody());
    }

    @Test
    public void acknowledgesOnlyCompleteLines() throws Exception {
        BesTraceSession session = new BesTraceSession();
        String data = " 1000/I/NONE  / 6 | [PWR] a\r\n 1001/I/NONE  / 6 | [SPK-TONE] b\r\n 1002/I/NO";
        BesTraceSession.Reply r = session.parse(reply(3, 100, 500, 0, data, 5000, 5000), RECEIVED);
        assertTrue(r.valid);
        assertEquals(2, r.lines.size());
        assertEquals(" 1000/I/NONE  / 6 | [PWR] a", r.lines.get(0).text);
        assertEquals(100, r.lines.get(0).position);
        assertEquals(100 + data.indexOf(" 1001"), r.lines.get(1).position);
        assertEquals(100 + data.lastIndexOf('\n') + 1, r.ackPosition);
        assertFalse("parse never moves the cursor", session.hasCursor());
        session.commit(r.generation, r.ackPosition);
        assertEquals(String.format(Locale.US, "{\"g\":3,\"p\":\"%016x\"}", r.ackPosition),
                session.requestBody());
    }

    @Test
    public void partialLineIsRereadNotSplit() throws Exception {
        BesTraceSession session = new BesTraceSession();
        BesTraceSession.Reply r = session.parse(reply(3, 100, 120, 0, " 1000/I/NO", 1, 1), RECEIVED);
        assertTrue(r.lines.isEmpty());
        assertEquals(100, r.ackPosition);
    }

    @Test
    public void fullReadWithoutNewlineIsKeptWhole() throws Exception {
        StringBuilder data = new StringBuilder();
        for (int i = 0; i < 320; i++) data.append('x');
        BesTraceSession.Reply r = new BesTraceSession()
                .parse(reply(3, 0, 1000, 0, data.toString(), 1, 1), RECEIVED);
        assertEquals(1, r.lines.size());
        assertEquals(320, r.ackPosition);
    }

    @Test
    public void lostBytesAndRebootAreExplicitLines() throws Exception {
        BesTraceSession session = new BesTraceSession(new BesTraceStore.Cursor(3, 50));
        BesTraceSession.Reply r = session.parse(reply(4, 900, 950, 850, "x\n", 1, 1), RECEIVED);
        assertEquals(3, r.lines.size());
        assertTrue(r.lines.get(0).text.startsWith("[ASG-BES-REBOOT] generation 3 -> 4"));
        assertTrue(r.lines.get(1).text.startsWith("[ASG-BES-GAP] lost=850"));
        assertEquals("x", r.lines.get(2).text);
    }

    @Test
    public void lineTimesComeFromBesTimestampsNotArrival() throws Exception {
        BesTraceSession session = new BesTraceSession();
        // Rate 1.048576: prefix runs fast. A line 104857.6 prefix-ms old is 100 s old.
        session.parse(reply(3, 0, 0, 0, "", 100_000, 104_858), RECEIVED - 600_000);
        String line = " 104858/I/NONE  / 6 | [PWR] old\n 1153434/I/NONE  / 6 | [PWR] new\n";
        BesTraceSession.Reply r = session.parse(reply(3, 0, 60, 0, line, 1_100_000, 1_153_434), RECEIVED);
        assertEquals(RECEIVED - 1_000_000, r.lines.get(0).wallMs, 5);
        assertEquals(RECEIVED, r.lines.get(1).wallMs);
    }

    @Test
    public void continuationLinesInheritThePreviousTime() throws Exception {
        String data = " 5000/I/NONE  / 6 | [TX]:\n02 80 20 0c\n";
        BesTraceSession.Reply r = new BesTraceSession()
                .parse(reply(3, 0, 40, 0, data, 5000, 5000), RECEIVED);
        assertEquals(r.lines.get(0).wallMs, r.lines.get(1).wallMs);
    }

    @Test
    public void errorsAndMalformedRepliesAreRejected() throws Exception {
        BesTraceSession session = new BesTraceSession();
        assertEquals("invalid_cursor",
                session.parse(new JSONObject("{\"error\":\"invalid_cursor\"}"), RECEIVED).error);
        assertFalse(session.parse(new JSONObject("{\"g\":1,\"p\":\"12\"}"), RECEIVED).valid);
        assertFalse(session.parse(reply(0, 0, 0, 0, "", 1, 1), RECEIVED).valid);
    }

    @Test
    public void backlogIsWhatRemainsAfterTheAck() throws Exception {
        BesTraceSession.Reply r = new BesTraceSession()
                .parse(reply(3, 0, 5000, 0, "abc\n", 1, 1), RECEIVED);
        assertEquals(4, r.ackPosition);
        assertEquals(4996, r.backlog());
    }

    private static final String BID_A = "9f3a0c1b2d4e5f60";
    private static final String BID_B = "1a2b3c4d5e6f7081";

    private static JSONObject withBid(JSONObject body, String bid) throws Exception {
        return body.put("bid", bid);
    }

    @Test
    public void requestsAndAcksNameTheBootOnceItIsKnown() throws Exception {
        BesTraceSession session = new BesTraceSession();
        BesTraceSession.Reply r = session.parse(
                withBid(reply(3, 0, 50, 0, "abc\n", 1, 1), BID_A), RECEIVED);
        assertEquals(BID_A, r.bid);
        session.commit(r.bid, r.generation, r.ackPosition);
        assertEquals(String.format(Locale.US, "{\"g\":3,\"p\":\"%016x\",\"bid\":\"%s\"}",
                r.ackPosition, BID_A), session.requestBody());
        assertEquals("{\"g\":3,\"p\":\"0000000000000004\",\"bid\":\"" + BID_A + "\"}",
                BesTraceSession.cursorBody(BID_A, 3, 4));
        assertEquals("old firmware bodies are unchanged",
                "{\"g\":3,\"p\":\"0000000000000004\"}", BesTraceSession.cursorBody(3, 4));
    }

    @Test
    public void aChangedBootResetsTheCursorAndWritesTheRebootLine() throws Exception {
        BesTraceSession session = new BesTraceSession(new BesTraceStore.Cursor(BID_A, 3, 5000));
        // The BES replies from its oldest retained byte with the new boot id; g may be unchanged.
        BesTraceSession.Reply r = session.parse(
                withBid(reply(3, 0, 40, 0, "boot\n", 1, 1), BID_B), RECEIVED);
        assertTrue(r.valid);
        assertEquals(2, r.lines.size());
        assertEquals("[ASG-BES-REBOOT] old_bid=" + BID_A + " new_bid=" + BID_B, r.lines.get(0).text);
        assertEquals(BID_B, r.lines.get(0).bid);
        assertEquals("boot", r.lines.get(1).text);
        session.commit(r.bid, r.generation, r.ackPosition);
        assertEquals(BID_B, session.bid());
        assertEquals(5, session.position());
        // The next reply from the same boot adds no marker.
        BesTraceSession.Reply next = session.parse(
                withBid(reply(3, 5, 40, 0, "more\n", 1, 1), BID_B), RECEIVED);
        assertEquals(1, next.lines.size());
    }

    @Test
    public void theSameBootWithAChangedGenerationIsNotAReboot() throws Exception {
        BesTraceSession session = new BesTraceSession(new BesTraceStore.Cursor(BID_A, 3, 50));
        BesTraceSession.Reply r = session.parse(
                withBid(reply(4, 50, 90, 0, "x\n", 1, 1), BID_A), RECEIVED);
        assertEquals("g is not an identity", 1, r.lines.size());
    }

    @Test
    public void oldFirmwareKeepsTheGenerationBasedRebootLine() throws Exception {
        BesTraceSession session = new BesTraceSession(new BesTraceStore.Cursor(3, 50));
        BesTraceSession.Reply r = session.parse(reply(4, 0, 4, 0, "x\n", 1, 1), RECEIVED);
        assertNull(r.bid);
        assertEquals("[ASG-BES-REBOOT] generation 3 -> 4", r.lines.get(0).text);
        // A firmware downgrade from a bid cursor falls back to the generation rule.
        BesTraceSession downgraded = new BesTraceSession(new BesTraceStore.Cursor(BID_A, 3, 50));
        BesTraceSession.Reply d = downgraded.parse(reply(4, 0, 4, 0, "x\n", 1, 1), RECEIVED);
        assertEquals("[ASG-BES-REBOOT] generation 3 -> 4", d.lines.get(0).text);
    }

    @Test
    public void aCursorFromBeforeBootIdsIsReplacedWhenTheFirmwareStartsSendingThem() throws Exception {
        BesTraceSession same = new BesTraceSession(new BesTraceStore.Cursor(3, 50));
        assertEquals("same generation: same boot, just adopt the bid", 1,
                same.parse(withBid(reply(3, 50, 90, 0, "x\n", 1, 1), BID_A), RECEIVED).lines.size());
        BesTraceSession other = new BesTraceSession(new BesTraceStore.Cursor(3, 50));
        BesTraceSession.Reply r = other.parse(
                withBid(reply(4, 0, 4, 0, "x\n", 1, 1), BID_A), RECEIVED);
        assertEquals("[ASG-BES-REBOOT] old_bid=none new_bid=" + BID_A, r.lines.get(0).text);
    }

    @Test
    public void bootIdsAreValidated() throws Exception {
        assertNull(BesTraceSession.parseBid(new JSONObject()));
        assertNull(BesTraceSession.parseBid(new JSONObject().put("bid", "0000000000000000")));
        assertNull(BesTraceSession.parseBid(new JSONObject().put("bid", "9F3A0C1B2D4E5F60")));
        assertNull(BesTraceSession.parseBid(new JSONObject().put("bid", "abc")));
        assertEquals(BID_A, BesTraceSession.parseBid(new JSONObject().put("bid", BID_A)));
        BesTraceSession.Reply r = new BesTraceSession().parse(
                withBid(reply(3, 0, 4, 0, "x\n", 1, 1), "nonsense"), RECEIVED);
        assertTrue(r.valid);
        assertNull("a malformed bid is treated as no bid", r.bid);
    }

    @Test
    public void advancingIsSeparateFromBeingDurable() throws Exception {
        BesTraceSession session = new BesTraceSession(new BesTraceStore.Cursor(BID_A, 3, 100));
        assertFalse(session.hasUndurableAdvance());
        session.advance(BID_A, 3, 400);
        assertTrue(session.hasUndurableAdvance());
        assertEquals("reads continue from the read-ahead position",
                BesTraceSession.cursorBody(BID_A, 3, 400), session.requestBody());
        assertEquals("but only the durable cursor may be acknowledged", 100,
                session.durableCursor().position);
        session.rollbackToDurable();
        assertEquals(100, session.position());
        assertFalse(session.hasUndurableAdvance());
        session.advance(BID_A, 3, 500);
        session.markDurable();
        assertEquals(500, session.durableCursor().position);
    }

    // ---- wall-time ordering (OS-1988 trace.txt monotonic) -----------------------------------

    private static void assertMonotonic(java.util.List<BesTraceStore.Line> lines) {
        long last = -1;
        for (BesTraceStore.Line line : lines) {
            assertTrue(line.text + " at " + line.wallMs + " after " + last, line.wallMs >= last);
            last = line.wallMs;
        }
    }

    /** The shape seen on hardware: lines lost, then a cut fragment, then older stamped lines. */
    private static final String AFTER_GAP = "/D/OTA   /  1 | app_flash_get_dev_id_by_addr(info.startAddr):0\n"
            + "      6853/I/NONE  /  1 | app_flash_register_module mod:3\n"
            + "      6853/D/OTA   /  1 | _register_bootinfo_user\n"
            + "      6900/I/NONE  /  1 | later line\n";

    @Test
    public void aGapMarkerAndTheFragmentAfterItSortWithTheDataTheyDescribe() throws Exception {
        BesTraceSession session = new BesTraceSession(new BesTraceStore.Cursor(BID_A, 1, 0x5000));
        // The reply arrives long after the lines were written: their ages are tens of seconds.
        BesTraceSession.Reply r = session.parse(withBid(
                reply(1, 0x5277, 0x9000, 140, AFTER_GAP, 100_000, 104_858), BID_A), RECEIVED);
        assertTrue(r.valid);
        assertTrue(r.lines.get(0).text.startsWith("[ASG-BES-GAP]"));
        assertMonotonic(r.lines);
        long firstStamped = r.lines.get(2).wallMs;
        assertTrue("stamped lines are older than the arrival", firstStamped < RECEIVED - 1000);
        assertEquals("the gap is no later than the first line after it", firstStamped,
                r.lines.get(0).wallMs);
        assertEquals("the cut fragment gets the time of the data it is next to", firstStamped,
                r.lines.get(1).wallMs);
        assertEquals(r.lines.get(r.lines.size() - 1).wallMs, r.lastWallMs);
    }

    @Test
    public void aRebootMarkerSortsWithTheFirstLineOfTheNewBoot() throws Exception {
        BesTraceSession session = new BesTraceSession(new BesTraceStore.Cursor(BID_A, 3, 5000));
        session.noteStored(RECEIVED - 40_000);
        String data = "      200/I/NONE  / 1 | boot a\n      300/I/NONE  / 1 | boot b\n";
        BesTraceSession.Reply r = session.parse(withBid(
                reply(3, 0, 80, 0, data, 100_000, 104_858), BID_B), RECEIVED);
        assertTrue(r.lines.get(0).text.startsWith("[ASG-BES-REBOOT]"));
        assertMonotonic(r.lines);
        assertEquals(r.lines.get(1).wallMs, r.lines.get(0).wallMs);
        assertTrue(r.lines.get(0).wallMs >= RECEIVED - 40_000);
    }

    @Test
    public void aBatchStartingWithAContinuationInheritsTheLastStoredTime() throws Exception {
        BesTraceSession session = new BesTraceSession();
        BesTraceSession.Reply first = session.parse(reply(3, 0, 200,0,
                "      5000/I/NONE  / 1 | head\n", 5000, 5000), RECEIVED);
        session.noteStored(first.lastWallMs);
        session.commit(first.generation, first.ackPosition);
        BesTraceSession.Reply second = session.parse(reply(3, first.ackPosition, 300, 0,
                "02 80 20 0c\n      5001/I/NONE  / 1 | next\n", 5001, 5001), RECEIVED + 10);
        assertMonotonic(second.lines);
        assertEquals(first.lastWallMs, second.lines.get(0).wallMs);
    }

    @Test
    public void linesNeverStepBackBecausePrefixesOrTheRateJitter() throws Exception {
        BesTraceSession session = new BesTraceSession();
        String data = "      5000/I/NONE  / 1 | a\n      4000/I/NONE  / 1 | out of order\n"
                + "      5100/I/NONE  / 1 | c\n";
        BesTraceSession.Reply a = session.parse(reply(3, 0, 200, 0, data, 5100, 5100), RECEIVED);
        assertMonotonic(a.lines);
        session.noteStored(a.lastWallMs);
        // A later reply whose lines map slightly earlier than what is already stored.
        BesTraceSession.Reply b = session.parse(reply(3, 90, 300, 0,
                "      5099/I/NONE  / 1 | d\n", 5101, 5101), RECEIVED - 500);
        assertTrue(b.lines.get(0).wallMs >= a.lastWallMs);
    }

    @Test
    public void aGapWithNoLinesAfterItSitsAtTheLastStoredTime() throws Exception {
        BesTraceSession session = new BesTraceSession(new BesTraceStore.Cursor(BID_A, 3, 50));
        session.noteStored(RECEIVED - 7000);
        BesTraceSession.Reply r = session.parse(withBid(
                reply(3, 900, 950, 850, "", 1, 1), BID_A), RECEIVED);
        assertEquals(1, r.lines.size());
        assertEquals(RECEIVED - 7000, r.lines.get(0).wallMs);
    }

    @Test
    public void aWallClockThatWentBackDoesNotPinNewLinesToTheFuture() throws Exception {
        BesTraceSession session = new BesTraceSession();
        session.noteStored(RECEIVED + 3_600_000); // stored while the clock was an hour ahead
        BesTraceSession.Reply r = session.parse(reply(3, 0, 40, 0,
                "      5000/I/NONE  / 1 | a\n", 5000, 5000), RECEIVED);
        assertEquals(RECEIVED, r.lines.get(0).wallMs);
        session.noteStored(r.lastWallMs);
        assertEquals(RECEIVED, session.sortableWall(RECEIVED + 1));
    }
}
