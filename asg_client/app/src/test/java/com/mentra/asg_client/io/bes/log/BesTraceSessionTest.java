package com.mentra.asg_client.io.bes.log;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
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
}
