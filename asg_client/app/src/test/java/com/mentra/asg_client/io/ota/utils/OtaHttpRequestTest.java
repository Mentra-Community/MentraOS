package com.mentra.asg_client.io.ota.utils;

import static org.junit.Assert.*;
import android.content.Context;
import java.io.*;
import java.net.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class OtaHttpRequestTest {
    static final class Connection extends HttpURLConnection {
        IOException connectFailure;
        InputStream body = new ByteArrayInputStream(new byte[]{1, 2, 3});
        boolean disconnected;
        int code = 200;
        Connection() throws Exception { super(new URL("https://example.com/artifact?token=secret")); }
        public void connect() throws IOException { if (connectFailure != null) throw connectFailure; }
        public void disconnect() { disconnected = true; }
        public boolean usingProxy() { return false; }
        public int getResponseCode() { return code; }
        public InputStream getInputStream() { return body; }
    }
    Context context() { return RuntimeEnvironment.getApplication(); }

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
}
