package com.mentra.asg_client.io.ota.utils;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.SystemClock;
import android.util.Log;
import com.mentra.asg_client.AsgConstants;
import java.io.File;
import java.io.FileOutputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;

/** One fresh OTA HTTP request, with unconditional cleanup and credential-free diagnostics. */
public final class OtaHttpRequest implements AutoCloseable {
    private final Context mContext;
    private final HttpURLConnection mConnection;
    private final JSONObject mTrace = new JSONObject();
    private final long mStarted = SystemClock.elapsedRealtime();
    private long mLastByte = mStarted;
    private long mBytes;
    private String mPhase = "connect";
    private InputStream mStream;
    private long mReadCount;
    private long mLastReadStarted = -1;
    private long mLastReadFinished = -1;
    private long mReadDuration;
    private long mMaxReadDuration;
    private long mLastReadDuration;
    private long mInterReadGap;
    private long mMaxInterReadGap;
    private long mBytesWritten;
    private long mWriteCount;
    private long mWriteDuration;
    private long mMaxWriteDuration;
    private long mLastWriteFinished = -1;
    private boolean mOutputTracked;
    private boolean mEof;
    private boolean mFailed;
    private boolean mTransferSnapshotTaken;

    public OtaHttpRequest(Context context, String url, String artifact) throws IOException {
        this(context, (HttpURLConnection) new URL(url).openConnection(), artifact);
    }

    // Injection seam for failures before headers/stream acquisition, without real network access.
    OtaHttpRequest(Context context, HttpURLConnection connection, String artifact) {
        mContext = context.getApplicationContext();
        mConnection = connection;
        connection.setConnectTimeout(OtaConstants.CONNECT_TIMEOUT_MS);
        connection.setReadTimeout(OtaConstants.READ_TIMEOUT_MS);
        connection.setUseCaches(false);
        put("attempt", UUID.randomUUID().toString());
        put("artifact", artifact);
        put("host", connection.getURL().getHost());
        put("networkStart", networkSnapshot());
    }

    /** Connects and rejects HTTP failures before creating a destination file. */
    public InputStream openStream() throws IOException {
        try {
            mConnection.connect();
            mPhase = "headers";
            int code = mConnection.getResponseCode();
            put("httpStatus", code);
            if (code < 200 || code >= 300) {
                throw new IOException("OTA HTTP status " + code);
            }
            mPhase = "body";
            mStream = new FilterInputStream(mConnection.getInputStream()) {
                @Override public int read() throws IOException {
                    long started = beginRead();
                    try {
                        int value = in.read();
                        finishedRead(started, value < 0 ? -1 : 1);
                        return value;
                    } catch (IOException e) {
                        finishedRead(started, 0);
                        recordFailure(e, "read");
                        throw failure(e);
                    }
                }
                @Override public int read(byte[] bytes, int offset, int count) throws IOException {
                    long started = beginRead();
                    try {
                        int value = in.read(bytes, offset, count);
                        finishedRead(started, value);
                        return value;
                    } catch (IOException e) {
                        finishedRead(started, 0);
                        recordFailure(e, "read");
                        throw failure(e);
                    }
                }
                @Override public void close() throws IOException {
                    snapshotTransfer(SystemClock.elapsedRealtime());
                    try { in.close(); }
                    catch (IOException e) { recordFailure(e, "input_close"); throw e; }
                }
            };
            return mStream;
        } catch (IOException e) { throw failure(e); }
    }

    public long contentLength() { return mConnection.getContentLengthLong(); }

    private long beginRead() {
        long now = SystemClock.elapsedRealtime();
        if (mLastReadFinished >= 0) {
            long gap = now - mLastReadFinished;
            mInterReadGap += gap;
            mMaxInterReadGap = Math.max(mMaxInterReadGap, gap);
        }
        mLastReadStarted = now;
        mReadCount++;
        return now;
    }

    private void finishedRead(long started, int count) {
        long now = SystemClock.elapsedRealtime();
        mLastReadFinished = now;
        mLastReadDuration = now - started;
        mReadDuration += mLastReadDuration;
        mMaxReadDuration = Math.max(mMaxReadDuration, mLastReadDuration);
        if (count > 0) {
            mBytes += count;
            mLastByte = now;
        } else if (count < 0) {
            mEof = true;
            snapshotTransfer(now);
        }
    }

    /** Internal APK output diagnostics; the original file operations and exceptions are preserved. */
    public OutputStream openOutput(File destination) throws IOException {
        try { return trackOutput(new FileOutputStream(destination)); }
        catch (IOException e) { recordFailure(e, "output_open"); throw e; }
    }

    // Injection seam for output timing/failures without filesystem or network operations.
    OutputStream trackOutput(OutputStream output) {
        mOutputTracked = true;
        return new OutputStream() {
            @Override public void write(int value) throws IOException {
                long started = SystemClock.elapsedRealtime();
                try {
                    output.write(value);
                    finishedWrite(started, 1);
                } catch (IOException e) {
                    finishedWrite(started, 0);
                    recordFailure(e, "output_write");
                    throw e;
                }
            }
            @Override public void write(byte[] bytes, int offset, int count) throws IOException {
                long started = SystemClock.elapsedRealtime();
                try {
                    output.write(bytes, offset, count);
                    finishedWrite(started, count);
                } catch (IOException e) {
                    finishedWrite(started, 0);
                    recordFailure(e, "output_write");
                    throw e;
                }
            }
            @Override public void flush() throws IOException { output.flush(); }
            @Override public void close() throws IOException {
                snapshotTransfer(SystemClock.elapsedRealtime());
                try { output.close(); }
                catch (IOException e) { recordFailure(e, "output_close"); throw e; }
            }
        };
    }

    private void finishedWrite(long started, int count) {
        long now = SystemClock.elapsedRealtime();
        long duration = now - started;
        mWriteCount++;
        mWriteDuration += duration;
        mMaxWriteDuration = Math.max(mMaxWriteDuration, duration);
        // A throwing write may have written a prefix; only normally returned writes are known.
        mBytesWritten += count;
        mLastWriteFinished = now;
    }

    private void recordFailure(IOException error, String operation) {
        if (!mFailed) {
            long now = SystemClock.elapsedRealtime();
            put("failureAtMs", now - mStarted);
            put("failureOperation", operation);
            put("failureClass", error.getClass().getSimpleName());
            snapshotTransfer(now);
            mFailed = true;
        }
    }

    private void snapshotTransfer(long now) {
        if (mTransferSnapshotTaken) return;
        mTransferSnapshotTaken = true;
        put("bytes", mBytes);
        put("elapsedMs", now - mStarted);
        put("lastByteAgeMs", now - mLastByte);
        put("eofReached", mEof);
        put("readCount", mReadCount);
        put("lastReadStartedMs", mLastReadStarted < 0 ? -1 : mLastReadStarted - mStarted);
        put("lastReadFinishedMs", mLastReadFinished < 0 ? -1 : mLastReadFinished - mStarted);
        put("lastReadDurationMs", mLastReadDuration);
        put("readDurationMs", mReadDuration);
        put("maxReadDurationMs", mMaxReadDuration);
        put("interReadGapMs", mInterReadGap);
        put("maxInterReadGapMs", mMaxInterReadGap);
        put("outputTracked", mOutputTracked);
        put("bytesWritten", mBytesWritten);
        put("writeCount", mWriteCount);
        put("writeDurationMs", mWriteDuration);
        put("maxWriteDurationMs", mMaxWriteDuration);
        put("lastWriteFinishedMs", mLastWriteFinished < 0 ? -1 : mLastWriteFinished - mStarted);
    }

    private IOException failure(IOException error) {
        recordFailure(error, mPhase);
        put("error", classify(error, mPhase, mTrace.optInt("httpStatus", 0)));
        // Exception messages may include signed URLs; retain only the causal class chain.
        JSONArray causes = new JSONArray();
        Throwable cause = error;
        for (int i = 0; cause != null && i < 8; i++, cause = cause.getCause()) {
            causes.put(cause.getClass().getSimpleName());
        }
        put("causes", causes);
        return new RequestException(mTrace.optString("error"), error);
    }

    /** Stable, phase-aware codes; lack of validation alone is not failure on local hotspot OTA. */
    public static String classify(IOException error, String phase, int httpStatus) {
        if (httpStatus >= 300) return "http_error";
        if (error instanceof java.net.SocketTimeoutException) {
            return "connect".equals(phase) ? "connect_timeout" : "download_timeout";
        }
        if (error instanceof java.net.UnknownHostException) return "dns_failed";
        if (error instanceof java.net.ConnectException) return "connection_failed";
        if (error instanceof javax.net.ssl.SSLException) {
            for (Throwable cause = error; cause != null; cause = cause.getCause()) {
                String message = cause.getMessage();
                if (cause instanceof java.security.cert.CertificateNotYetValidException
                        || (message != null && (message.contains("Certificate not yet valid")
                        || message.contains("timestamp check failed")))) return "clock_skew";
            }
            return "ssl_error";
        }
        return "download_failed";
    }

    /** Carries the phase classification through the existing OTA error path. */
    public static final class RequestException extends IOException {
        public final String errorCode;
        RequestException(String code, IOException cause) { super(code, cause); errorCode = code; }
    }

    private JSONObject networkSnapshot() {
        JSONObject result = new JSONObject();
        try {
            ConnectivityManager manager = (ConnectivityManager) mContext.getSystemService(Context.CONNECTIVITY_SERVICE);
            Network network = manager == null ? null : manager.getActiveNetwork();
            result.put("id", network == null ? "none" : network.toString());
            NetworkCapabilities caps = network == null ? null : manager.getNetworkCapabilities(network);
            result.put("wifi", caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI));
            result.put("validated", caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED));
            result.put("captivePortal", caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_CAPTIVE_PORTAL));
            LinkProperties link = network == null ? null : manager.getLinkProperties(network);
            result.put("interface", link == null ? "" : link.getInterfaceName());
            result.put("dns", link == null ? "" : link.getDnsServers().toString());
        } catch (Exception ignored) { /* Diagnostics must never gate local OTA. */ }
        return result;
    }

    private void put(String key, Object value) {
        try { mTrace.put(key, value); } catch (Exception ignored) { }
    }

    @Override public void close() {
        snapshotTransfer(SystemClock.elapsedRealtime());
        try { if (mStream != null) mStream.close(); } catch (IOException ignored) { }
        finally { mConnection.disconnect(); }
        put("phase", mPhase);
        put("bodyOutcome", mFailed ? "failed" : mEof ? "eof" : "incomplete");
        put("networkEnd", networkSnapshot());
        retain(mContext, mTrace);
    }

    private static synchronized void retain(Context context, JSONObject trace) {
        try {
            JSONArray entries = recentEntries(context);
            JSONArray bounded = new JSONArray();
            for (int i = Math.max(0, entries.length() - AsgConstants.OTA_NETWORK_HISTORY_LIMIT + 1); i < entries.length(); i++) {
                bounded.put(entries.get(i));
            }
            JSONObject entry = new JSONObject().put("timestamp", System.currentTimeMillis())
                    .put("level", trace.has("error") || "failed".equals(trace.optString("bodyOutcome")) ? "warn" : "info")
                    .put("source", "OtaHttpRequest").put("message", trace.toString());
            bounded.put(entry);
            context.getSharedPreferences(AsgConstants.OTA_NETWORK_HISTORY_PREFS, Context.MODE_PRIVATE)
                    .edit().putString("entries", bounded.toString()).commit();
            Log.i("OtaHttpRequest", trace.toString());
        } catch (Exception ignored) { }
    }

    /** Incident entries survive logcat churn and ordinary ASG process restarts. */
    public static synchronized JSONArray recentEntries(Context context) {
        try {
            return new JSONArray(context.getSharedPreferences(AsgConstants.OTA_NETWORK_HISTORY_PREFS, Context.MODE_PRIVATE)
                    .getString("entries", "[]"));
        } catch (Exception ignored) { return new JSONArray(); }
    }
}
