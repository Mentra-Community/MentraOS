package com.mentra.asg_client.io.streaming;

import static org.junit.Assert.*;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(manifest = Config.NONE)
public class StreamStatusSnapshotTest {
    @Test
    public void processRestartStartsStoppedWithNewSession() throws Exception {
        JSONObject state = new StreamStatusSnapshot("new-asg").snapshot();
        assertEquals("stopped", state.getString("status"));
        assertEquals("new-asg", state.getString("sid"));
        assertTrue(state.getBoolean("terminal"));
        assertFalse(state.has("streamId"));
    }

    @Test
    public void retainsTerminalReasonAcrossCleanupWithoutAnyTransport() throws Exception {
        StreamStatusSnapshot store = new StreamStatusSnapshot("asg");
        store.begin("stream-a");
        assertTrue(store.update(event("stream-a", "error").put("errorDetails", "phone disconnected")));
        assertTrue(store.update(event("stream-a", "stopped")));
        JSONObject state = store.snapshot();
        assertEquals("phone disconnected", state.getString("errorDetails"));
        assertEquals("stream-a", state.getString("streamId"));
        assertTrue(state.getBoolean("terminal"));
    }

    @Test
    public void retryingErrorIsNotTerminalAndCanRecover() throws Exception {
        StreamStatusSnapshot store = new StreamStatusSnapshot("asg");
        store.begin("a");
        store.update(event("a", "error").put("willRetry", true));
        assertEquals("reconnecting", store.snapshot().getString("status"));
        assertFalse(store.snapshot().getBoolean("terminal"));
        assertTrue(store.update(event("a", "reconnected")));
        assertTrue(store.snapshot().getBoolean("streaming"));
    }

    @Test
    public void ignoresOldStreamAndLateResurrection() throws Exception {
        StreamStatusSnapshot store = new StreamStatusSnapshot("asg");
        store.begin("old");
        store.begin("new");
        long revision = store.snapshot().getLong("revision");
        assertFalse(store.update(event("old", "stopped")));
        assertEquals(revision, store.snapshot().getLong("revision"));
        assertTrue(store.update(event("new", "stopped")));
        assertFalse(store.update(event("new", "streaming")));
        assertEquals("stopped", store.snapshot().getString("status"));
    }

    @Test
    public void returnedSnapshotsCannotMutateRetainedState() throws Exception {
        StreamStatusSnapshot store = new StreamStatusSnapshot("asg");
        store.begin("a");
        store.snapshot().put("status", "streaming");
        assertEquals("initializing", store.snapshot().getString("status"));
    }

    private static JSONObject event(String id, String status) throws Exception {
        return new JSONObject().put("streamId", id).put("status", status);
    }
}
