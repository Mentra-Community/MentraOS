package com.mentra.asg_client.io.ota.utils;

import static org.junit.Assert.*;
import android.content.Context;
import java.io.*;
import java.net.*;
import java.time.Duration;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowSystemClock;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class OtaHttpRequestTest {
    static final class Connection extends HttpURLConnection {
        IOException connectFailure;
        InputStream body = new ByteArrayInputStream(new byte[]{1, 2, 3});
        boolean disconnected;
        int code = 200;
        long disconnectDelayMs;
        Connection() throws Exception { super(new URL("https://example.com/artifact?token=secret")); }
        public void connect() throws IOException { if (connectFailure != null) throw connectFailure; }
        public void disconnect() { advance(disconnectDelayMs); disconnected = true; }
        public boolean usingProxy() { return false; }
        public int getResponseCode() { return code; }
        public InputStream getInputStream() { return body; }
    }
    Context context() { return RuntimeEnvironment.getApplication(); }
    static void advance(long ms) { ShadowSystemClock.advanceBy(Duration.ofMillis(ms)); }
    JSONObject lastTrace() throws Exception {
        JSONArray entries = OtaHttpRequest.recentEntries(context());
        return new JSONObject(entries.getJSONObject(entries.length() - 1).getString("message"));
    }

    @Test public void connectionFailureStillDisconnectsAndPreservesCategory() throws Exception {
        Connection connection = new Connection();
        connection.connectFailure = new UnknownHostException("secret");
        try (OtaHttpRequest request = new OtaHttpRequest(context(), connection, "apk")) {
            request.openStream(); fail();
        } catch (OtaHttpRequest.RequestException e) { assertEquals("dns_failed", e.errorCode); }
        assertTrue(connection.disconnected);
        String history = OtaHttpRequest.recentEntries(context()).toString();
        assertTrue(history.contains("UnknownHostException"));
        assertFalse(history.contains("secret"));
        assertFalse(history.contains("token="));
    }

    @Test public void readStallClosesStreamAndFreshRetrySucceeds() throws Exception {
        Connection stalled = new Connection();
        boolean[] closed = {false};
        stalled.body = new InputStream() {
            public int read() throws IOException { throw new SocketTimeoutException(); }
            public void close() { closed[0] = true; }
        };
        try (OtaHttpRequest request = new OtaHttpRequest(context(), stalled, "apk")) {
            request.openStream().read(); fail();
        } catch (OtaHttpRequest.RequestException e) { assertEquals("download_timeout", e.errorCode); }
        assertTrue(closed[0]);
        assertTrue(stalled.disconnected);
        Connection healthy = new Connection();
        try (OtaHttpRequest request = new OtaHttpRequest(context(), healthy, "apk")) {
            assertEquals(3, request.openStream().readAllBytes().length);
        }
        assertTrue(healthy.disconnected);
    }

    @Test public void httpFailureDisconnectsBeforeOpeningBody() throws Exception {
        Connection connection = new Connection(); connection.code = 503;
        try (OtaHttpRequest request = new OtaHttpRequest(context(), connection, "manifest")) {
            request.openStream(); fail();
        } catch (OtaHttpRequest.RequestException e) { assertEquals("http_error", e.errorCode); }
        assertTrue(connection.disconnected);
    }

    @Test public void androidCertificateTimestampFailureStillRequestsClockSync() {
        javax.net.ssl.SSLException error = new javax.net.ssl.SSLException("handshake failed");
        error.initCause(new java.security.cert.CertificateException("timestamp check failed"));
        assertEquals("clock_skew", OtaHttpRequest.classify(error, "connect", 0));
    }

    @Test public void classificationDoesNotClaimInternetIsDown() {
        assertEquals("connect_timeout", OtaHttpRequest.classify(new SocketTimeoutException(), "connect", 0));
        assertEquals("download_timeout", OtaHttpRequest.classify(new SocketTimeoutException(), "headers", 0));
        assertEquals("connection_failed", OtaHttpRequest.classify(new ConnectException(), "connect", 0));
        assertEquals("ssl_error", OtaHttpRequest.classify(new javax.net.ssl.SSLException("handshake"), "connect", 0));
    }
    @Test public void slowOutputIsSeparatedFromReadWaitAndProgressGap() throws Exception {
        Connection connection = new Connection();
        connection.body = new ByteArrayInputStream(new byte[]{1, 2, 3});
        int[] bulkWrites = {0};
        int[] singleWrites = {0};
        try (OtaHttpRequest request = new OtaHttpRequest(context(), connection, "apk");
                InputStream in = request.openStream();
                OutputStream out = request.trackOutput(new OutputStream() {
                    public void write(int value) { singleWrites[0]++; }
                    public void write(byte[] bytes, int offset, int count) {
                        bulkWrites[0]++;
                        advance(120);
                    }
                })) {
            byte[] buffer = new byte[2];
            int count;
            while ((count = in.read(buffer)) > 0) {
                out.write(buffer, 0, count);
                advance(30); // Existing progress/session work between writes and the next read.
            }
        }
        JSONObject trace = lastTrace();
        assertEquals(2, bulkWrites[0]);
        assertEquals(0, singleWrites[0]); // Bulk writes still delegate once, never per byte.
        assertEquals(3, trace.getLong("bytes"));
        assertEquals(3, trace.getLong("bytesWritten"));
        assertEquals(3, trace.getLong("readCount"));
        assertEquals(0, trace.getLong("readDurationMs"));
        assertEquals(240, trace.getLong("writeDurationMs"));
        assertEquals(120, trace.getLong("maxWriteDurationMs"));
        assertEquals(300, trace.getLong("interReadGapMs"));
        assertEquals(150, trace.getLong("maxInterReadGapMs"));
        assertEquals(300, trace.getLong("lastReadStartedMs"));
        assertEquals(270, trace.getLong("lastWriteFinishedMs"));
        assertEquals("eof", trace.getString("bodyOutcome"));
        assertTrue(trace.getBoolean("eofReached"));
        assertFalse(trace.has("error"));
    }

    @Test public void blockedReadCapturesFailureBeforeSlowCleanup() throws Exception {
        Connection connection = new Connection();
        connection.disconnectDelayMs = 700;
        SocketTimeoutException timeout = new SocketTimeoutException("private signed URL");
        connection.body = new InputStream() {
            int reads;
            public int read() throws IOException {
                if (reads++ == 0) { advance(7); return 42; }
                advance(OtaConstants.READ_TIMEOUT_MS);
                throw timeout;
            }
            public void close() { advance(500); }
        };
        try (OtaHttpRequest request = new OtaHttpRequest(context(), connection, "apk");
                InputStream in = request.openStream();
                OutputStream out = request.trackOutput(new OutputStream() {
                    public void write(int value) { advance(3); }
                    public void close() { advance(600); }
                })) {
            out.write(in.read());
            advance(4);
            in.read();
            fail();
        } catch (OtaHttpRequest.RequestException error) {
            assertEquals("download_timeout", error.errorCode);
            assertSame(timeout, error.getCause());
        }
        JSONObject trace = lastTrace();
        assertEquals("failed", trace.getString("bodyOutcome"));
        assertEquals("read", trace.getString("failureOperation"));
        assertEquals(14, trace.getLong("lastReadStartedMs"));
        assertEquals(20014, trace.getLong("lastReadFinishedMs"));
        assertEquals(20014, trace.getLong("failureAtMs"));
        assertEquals(20014, trace.getLong("elapsedMs"));
        assertEquals(20007, trace.getLong("lastByteAgeMs"));
        assertEquals(20007, trace.getLong("readDurationMs"));
        assertEquals(20000, trace.getLong("maxReadDurationMs"));
        assertEquals(7, trace.getLong("interReadGapMs"));
        assertEquals(3, trace.getLong("writeDurationMs"));
        assertEquals(1, trace.getLong("bytesWritten"));
        assertFalse(trace.getBoolean("eofReached"));
        assertFalse(trace.toString().contains("private signed URL"));
        assertTrue(connection.disconnected);
    }

    @Test public void eofSnapshotExcludesAllResourceCleanupDelays() throws Exception {
        Connection connection = new Connection();
        connection.disconnectDelayMs = 700;
        connection.body = new ByteArrayInputStream(new byte[]{1}) {
            @Override public void close() { advance(500); }
        };
        try (OtaHttpRequest request = new OtaHttpRequest(context(), connection, "apk");
                InputStream in = request.openStream();
                OutputStream out = request.trackOutput(new OutputStream() {
                    public void write(int value) { advance(5); }
                    public void close() { advance(600); }
                })) {
            out.write(in.read());
            assertEquals(-1, in.read());
        }
        JSONObject trace = lastTrace();
        assertEquals(5, trace.getLong("elapsedMs"));
        assertEquals(5, trace.getLong("lastByteAgeMs"));
        assertEquals(5, trace.getLong("writeDurationMs"));
        assertEquals("eof", trace.getString("bodyOutcome"));
    }

    @Test public void throwingOutputPreservesIdentityAndOnlyCountsCompletedWrites() throws Exception {
        Connection connection = new Connection();
        IOException failure = new IOException("output full with private path");
        try (OtaHttpRequest request = new OtaHttpRequest(context(), connection, "apk");
                InputStream in = request.openStream();
                OutputStream out = request.trackOutput(new OutputStream() {
                    int writes;
                    public void write(int value) throws IOException {
                        advance(8);
                        if (writes++ > 0) throw failure;
                    }
                    public void close() { advance(100); }
                })) {
            out.write(in.read());
            out.write(in.read());
            fail();
        } catch (IOException error) { assertSame(failure, error); }
        JSONObject trace = lastTrace();
        assertEquals("failed", trace.getString("bodyOutcome"));
        assertEquals("output_write", trace.getString("failureOperation"));
        assertEquals("IOException", trace.getString("failureClass"));
        assertEquals(2, trace.getLong("bytes"));
        assertEquals(1, trace.getLong("bytesWritten"));
        assertEquals(16, trace.getLong("writeDurationMs"));
        assertEquals(16, trace.getLong("failureAtMs"));
        assertEquals(16, trace.getLong("elapsedMs"));
        assertFalse(trace.has("error")); // Output errors retain the caller's original classification.
        assertFalse(trace.toString().contains("private path"));
    }

    @Test public void outputOpenFailurePreservesOriginalCategoryWithoutBodyReads() throws Exception {
        Connection connection = new Connection();
        File missing = new File(context().getCacheDir(), "missing-parent-" + System.nanoTime() + "/apk");
        try (OtaHttpRequest request = new OtaHttpRequest(context(), connection, "apk");
                InputStream in = request.openStream()) {
            request.openOutput(missing);
            fail();
        } catch (FileNotFoundException expected) { }
        JSONObject trace = lastTrace();
        assertEquals("output_open", trace.getString("failureOperation"));
        assertEquals("failed", trace.getString("bodyOutcome"));
        assertEquals(0, trace.getLong("readCount"));
        assertFalse(trace.has("error"));
    }

    @Test public void closeFailureMarksFailedButDoesNotOverwriteOriginalReadFailure() throws Exception {
        Connection connection = new Connection();
        SocketTimeoutException original = new SocketTimeoutException();
        IOException closing = new IOException("output close");
        connection.body = new InputStream() {
            public int read() throws IOException { advance(20); throw original; }
        };
        try (OtaHttpRequest request = new OtaHttpRequest(context(), connection, "apk");
                InputStream in = request.openStream();
                OutputStream out = request.trackOutput(new OutputStream() {
                    public void write(int value) { }
                    public void close() throws IOException { advance(100); throw closing; }
                })) {
            in.read();
            fail();
        } catch (OtaHttpRequest.RequestException error) {
            assertSame(original, error.getCause());
            assertEquals(1, error.getSuppressed().length);
            assertSame(closing, error.getSuppressed()[0]);
        }
        JSONObject trace = lastTrace();
        assertEquals("read", trace.getString("failureOperation"));
        assertEquals(20, trace.getLong("failureAtMs"));
        assertEquals(20, trace.getLong("elapsedMs"));
        assertEquals("download_timeout", trace.getString("error"));
    }

    @Test public void outputCloseFailureAfterEofIsNotSuccessfulBodyOutcome() throws Exception {
        Connection connection = new Connection();
        IOException closing = new IOException("output close");
        try (OtaHttpRequest request = new OtaHttpRequest(context(), connection, "apk");
                InputStream in = request.openStream();
                OutputStream out = request.trackOutput(new OutputStream() {
                    public void write(int value) { }
                    public void close() throws IOException { advance(100); throw closing; }
                })) {
            assertEquals(3, in.readAllBytes().length);
        } catch (IOException error) { assertSame(closing, error); }
        JSONObject trace = lastTrace();
        assertTrue(trace.getBoolean("eofReached"));
        assertEquals("failed", trace.getString("bodyOutcome"));
        assertEquals("output_close", trace.getString("failureOperation"));
        assertEquals(100, trace.getLong("failureAtMs"));
        assertEquals(0, trace.getLong("elapsedMs"));
    }

    @Test public void closingUnreadBodyIsIncompleteAndZeroReadsAreNotEof() throws Exception {
        Connection connection = new Connection();
        connection.body = new InputStream() {
            public int read() { return -1; }
            public int read(byte[] bytes, int offset, int count) { return 0; }
        };
        try (OtaHttpRequest request = new OtaHttpRequest(context(), connection, "apk");
                InputStream in = request.openStream()) {
            assertEquals(0, in.read(new byte[0]));
            assertEquals(0, in.read(new byte[1]));
        }
        JSONObject trace = lastTrace();
        assertEquals(0, trace.getLong("bytes"));
        assertFalse(trace.getBoolean("eofReached"));
        assertEquals("incomplete", trace.getString("bodyOutcome"));
    }

}
