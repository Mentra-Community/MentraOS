package com.mentra.asg_client.io.bluetooth.managers.mentralive.internal;

import android.content.Context;
import android.util.Log;
import com.lhs.serialport.api.SerialManager;
import com.mentra.asg_client.io.bes.BesOtaUartListener;
import com.mentra.asg_client.io.bluetooth.interfaces.SerialListener;
import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/** Manager for serial communication with the BES2700 Bluetooth module in K900 devices. */
public class SerialPortBridge {
    private static final String TAG = "SerialPortBridge";

    // Serial port configuration - matches the K900 SDK
    private static final String COM_PATH = "/dev/ttyS1";

    /** Default UART baud rate. The BES2700 always boots (and reverts) to this rate. */
    public static final int DEFAULT_BAUDRATE = 460800;

    private static final int COM_BAUDRATE = DEFAULT_BAUDRATE;

    /** Log tag for runtime baud switching so the negotiation is easy to grep. */
    private static final String BAUD_TAG = "BAUD-SWITCH";

    private SerialListener mListener;
    private BesOtaUartListener mOtaListener;
    private RecvThread mRecvThread = null;
    private byte[] mReadBuf = new byte[1024];
    private boolean mbStart = false;
    // volatile + snapshot-before-use: reopen() nulls these on the baud-switch
    // thread while send/recv threads are mid-call. A stale stream throws a
    // handled IOException; a raw field read after the null-check would NPE.
    protected volatile OutputStream mOS;
    protected volatile InputStream mIS;
    private Context mContext = null;
    private boolean mbRequestFast = false;
    public boolean mbOtaUpdating = false;

    /** Baud rate the port is currently open at (DEFAULT_BAUDRATE until a reopen succeeds). */
    private volatile int mCurrentBaud = DEFAULT_BAUDRATE;

    /**
     * Create a new SerialPortBridge
     *
     * @param context The application context
     */
    public SerialPortBridge(Context context) {
        mContext = context;
    }

    /**
     * Register a listener for serial events
     *
     * @param listener The listener to register
     */
    public void registerListener(SerialListener listener) {
        mListener = listener;
    }

    /**
     * Register a listener for BES OTA UART data
     *
     * @param listener The OTA listener to register
     */
    public void registerOtaListener(BesOtaUartListener listener) {
        mOtaListener = listener;
    }

    /**
     * Start the serial communication
     *
     * @return true if started successfully, false otherwise
     */
    public boolean start() {
        if (mbStart) return true;

        boolean bSucc = SerialManager.getInstance().openSerial(COM_PATH, COM_BAUDRATE);
        Log.d(TAG, "openSerial dev=" + COM_PATH + ", bSucc=" + bSucc);

        if (mListener != null) mListener.onSerialOpen(bSucc, 0, COM_PATH, "");

        if (bSucc) {
            mbStart = true;
            mCurrentBaud = COM_BAUDRATE;
            mIS = SerialManager.getInstance().getInputStream(COM_PATH);
            mOS = SerialManager.getInstance().getOutputStream(COM_PATH);

            if (mRecvThread != null) {
                mRecvThread.setStop();
                mRecvThread = null;
            }

            mRecvThread = new RecvThread();
            mRecvThread.start();

            if (mListener != null) mListener.onSerialReady(COM_PATH);
        }

        return bSucc;
    }

    /** Stop the serial communication */
    public void stop() {
        if (mbStart) {
            Log.d(TAG, "SerialPortBridge stopping");
            if (mRecvThread != null) {
                mRecvThread.setStop();
                mRecvThread.interrupt();
                mRecvThread = null;
            }
            SerialManager.getInstance().closeSerial(COM_PATH);
            mbStart = false;

            if (mListener != null) mListener.onSerialClose(COM_PATH);

            Log.d(TAG, "SerialPortBridge stopped");
        }
    }

    /**
     * Get the baud rate the serial port is currently open at.
     *
     * @return the current baud rate (DEFAULT_BAUDRATE unless a reopen() changed it)
     */
    public int getCurrentBaud() {
        return mCurrentBaud;
    }

    /**
     * Close the serial port and reopen /dev/ttyS1 at the given baud rate. Used by the runtime UART
     * baud switch (cs_baud/sr_baud negotiation with the BES2700). Listener registrations
     * (mListener/mOtaListener) are instance fields and are preserved across the reopen; no
     * onSerialClose/onSerialOpen/onSerialReady callbacks are fired so higher layers keep their
     * negotiated wire-protocol state.
     *
     * <p>Defensive: if the port cannot be reopened at the requested baud, this method falls back to
     * DEFAULT_BAUDRATE so the port is never left closed.
     *
     * @param baud The new baud rate (must be one of the rates supported by liblhsserial, e.g.
     *     460800, 921600, 1152000, 1500000, 2000000)
     * @return true if the port is open at the requested baud, false otherwise (including when the
     *     internal fallback to DEFAULT_BAUDRATE was used)
     */
    public synchronized boolean reopen(int baud) {
        if (!mbStart) {
            Log.e(BAUD_TAG, "reopen(" + baud + ") requested but serial port was never started");
            return false;
        }

        Log.i(BAUD_TAG, "Reopening " + COM_PATH + " at " + baud + " (was " + mCurrentBaud + ")");

        // Stop the receive thread first so the old and new threads never read the same stream.
        if (mRecvThread != null) {
            mRecvThread.setStop();
            mRecvThread.interrupt();
            if (Thread.currentThread() != mRecvThread) {
                try {
                    mRecvThread.join(1000);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
                if (mRecvThread.isAlive()) {
                    Log.w(BAUD_TAG, "Old RecvThread did not exit within 1s; continuing reopen");
                }
            }
            mRecvThread = null;
        }

        mbStart = false;
        mIS = null;
        mOS = null;

        try {
            SerialManager.getInstance().closeSerial(COM_PATH);
        } catch (Exception e) {
            Log.e(BAUD_TAG, "Error closing serial port before reopen", e);
        }

        boolean bSucc = openAtBaud(baud);
        boolean atRequestedBaud = bSucc;

        if (!bSucc && baud != DEFAULT_BAUDRATE) {
            // Never leave the port closed; fall back to the default rate the BES reverts to.
            Log.e(
                    BAUD_TAG,
                    "Reopen at " + baud + " FAILED - falling back to " + DEFAULT_BAUDRATE);
            bSucc = openAtBaud(DEFAULT_BAUDRATE);
            baud = DEFAULT_BAUDRATE;
        }

        if (!bSucc) {
            Log.e(BAUD_TAG, "Serial port could not be reopened at any baud - port is CLOSED");
            return false;
        }

        mCurrentBaud = baud;
        mIS = SerialManager.getInstance().getInputStream(COM_PATH);
        mOS = SerialManager.getInstance().getOutputStream(COM_PATH);
        mbStart = true;

        mRecvThread = new RecvThread();
        mRecvThread.start();

        Log.i(BAUD_TAG, "Serial port reopened at " + baud + " baud");
        return atRequestedBaud;
    }

    /** Open COM_PATH at the given baud, catching any exception. Helper for reopen(). */
    private boolean openAtBaud(int baud) {
        try {
            boolean bSucc = SerialManager.getInstance().openSerial(COM_PATH, baud);
            Log.d(BAUD_TAG, "openSerial dev=" + COM_PATH + " baud=" + baud + " bSucc=" + bSucc);
            return bSucc;
        } catch (Exception e) {
            Log.e(BAUD_TAG, "Exception opening serial at baud " + baud, e);
            return false;
        }
    }

    /**
     * Serializes all writers into the tty. The EAGAIN drain loop below yields (2ms sleeps)
     * mid-frame whenever the ~4KB tty buffer fills, so two threads writing concurrently
     * (ack-pump thread + fileTransferExecutor retry thread, observed interleaved within the
     * same millisecond in OS-1409 logs) splice their frames together on the wire. The BES
     * parser then rejects the mangled frames, and the concurrent-write churn precedes every
     * observed one-way MTK->BES TX wedge (bytes written "successfully" never reach the BES
     * UART ISR). One writer at a time, whole frames only.
     */
    private final Object mWriteLock = new Object();

    // #region agent log
    // OS-1409 debug session 966030: ships structured events to the host debug ingest
    // server via `adb reverse tcp:7905 tcp:7905`. Fire-and-forget. Remove once the
    // stalled-retransmit root cause is confirmed.
    private static final String DEBUG_LOG_URL =
            "http://127.0.0.1:7905/ingest/5a9713c9-45ff-4d09-9435-2adc5db5e91d";
    private static final String DEBUG_SESSION_ID = "966030";

    private static void debugLog(
            String location, String message, String hypothesisId, JSONObject data) {
        try {
            JSONObject payload = new JSONObject();
            payload.put("sessionId", DEBUG_SESSION_ID);
            payload.put("location", location);
            payload.put("message", message);
            payload.put("hypothesisId", hypothesisId);
            payload.put("data", data == null ? new JSONObject() : data);
            payload.put("timestamp", System.currentTimeMillis());
            final String body = payload.toString();
            new Thread(
                            () -> {
                                try {
                                    java.net.HttpURLConnection conn =
                                            (java.net.HttpURLConnection)
                                                    new java.net.URL(DEBUG_LOG_URL)
                                                            .openConnection();
                                    conn.setRequestMethod("POST");
                                    conn.setDoOutput(true);
                                    conn.setConnectTimeout(1000);
                                    conn.setReadTimeout(1000);
                                    conn.setRequestProperty("Content-Type", "application/json");
                                    conn.setRequestProperty(
                                            "X-Debug-Session-Id", DEBUG_SESSION_ID);
                                    conn.getOutputStream()
                                            .write(body.getBytes(StandardCharsets.UTF_8));
                                    conn.getInputStream().close();
                                    conn.disconnect();
                                } catch (Exception ignored) {
                                }
                            })
                    .start();
        } catch (Exception ignored) {
        }
    }
    // #endregion agent log

    /**
     * Write all bytes to the serial port, draining EAGAIN. liblhsserial opens /dev/ttyS1
     * O_NONBLOCK (verified by disassembly: open flags 0x902), so large bursts overrun the
     * kernel's ~4KB tty TX buffer and FileOutputStream.write throws EAGAIN after an UNKNOWN
     * number of bytes already left the process - corrupting the stream on retry. Os.write
     * gives exact-byte accounting; on EAGAIN we wait for the line to drain (~4KB at 1.152M
     * is ~36ms) and continue from the precise offset. This is what restores the "write
     * blocks at line rate" pacing the push-mode file pump is designed around.
     *
     * @return true if every byte was written
     */
    private boolean writeAllToSerial(OutputStream os, byte[] data, String what) {
        synchronized (mWriteLock) {
            return writeAllToSerialLocked(os, data, what);
        }
    }

    private boolean writeAllToSerialLocked(OutputStream os, byte[] data, String what) {
        java.io.FileDescriptor fd;
        try {
            fd = ((java.io.FileOutputStream) os).getFD();
        } catch (IOException | ClassCastException e) {
            // No FD access - fall back to the plain stream write (single-shot).
            try {
                os.write(data);
                os.flush();
                return true;
            } catch (IOException e2) {
                Log.e(TAG, "Error writing " + what + " to serial port: " + e2.getMessage());
                return false;
            }
        }

        int off = 0;
        int eagainWaits = 0;
        int totalEagainWaits = 0;
        long writeStart = System.currentTimeMillis();
        // 500 x 2ms = 1s of cumulative drain budget; the line moves ~230B/2ms at 1.152M.
        final int maxEagainWaits = 500;
        while (off < data.length) {
            try {
                int written = android.system.Os.write(fd, data, off, data.length - off);
                if (written > 0) {
                    off += written;
                    eagainWaits = 0;
                }
            } catch (android.system.ErrnoException e) {
                if (e.errno == android.system.OsConstants.EAGAIN
                        || e.errno == android.system.OsConstants.EINTR) {
                    totalEagainWaits++;
                    if (++eagainWaits > maxEagainWaits) {
                        Log.e(
                                TAG,
                                "Serial TX stalled writing "
                                        + what
                                        + " ("
                                        + off
                                        + "/"
                                        + data.length
                                        + " bytes)");
                        // #region agent log
                        // H2: TX wedge check - did the write actually stall (bytes short
                        // of data.length) rather than the previous silent-success theory.
                        if ("file".equals(what)) {
                            try {
                                JSONObject d = new JSONObject();
                                d.put("what", what);
                                d.put("bytesWritten", off);
                                d.put("bytesTotal", data.length);
                                d.put("eagainWaits", totalEagainWaits);
                                d.put("thread", Thread.currentThread().getName());
                                debugLog(
                                        "SerialPortBridge.writeAllToSerialLocked",
                                        "write stalled",
                                        "H2",
                                        d);
                            } catch (Exception ignored) {
                            }
                        }
                        // #endregion agent log
                        return false;
                    }
                    try {
                        Thread.sleep(2);
                    } catch (InterruptedException ie) {
                        Thread.currentThread().interrupt();
                        return false;
                    }
                } else {
                    Log.e(TAG, "Error writing " + what + " to serial port: errno=" + e.errno);
                    return false;
                }
            } catch (InterruptedIOException e) {
                Log.e(TAG, "Interrupted writing " + what + " to serial port");
                return false;
            }
        }
        // #region agent log
        // H2: confirm every "file" write completes off==data.length exactly (Os.write
        // exact-byte accounting) and record any EAGAIN drain time, so a "packet sent"
        // in K900BluetoothManager can be cross-checked against the actual UART write.
        if ("file".equals(what) && totalEagainWaits > 0) {
            try {
                JSONObject d = new JSONObject();
                d.put("what", what);
                d.put("bytesWritten", off);
                d.put("bytesTotal", data.length);
                d.put("eagainWaits", totalEagainWaits);
                d.put("durationMs", System.currentTimeMillis() - writeStart);
                d.put("thread", Thread.currentThread().getName());
                debugLog("SerialPortBridge.writeAllToSerialLocked", "write completed", "H2", d);
            } catch (Exception ignored) {
            }
        }
        // #endregion agent log
        return true;
    }

    /**
     * Send data over the serial port Blocked during BES OTA updates
     *
     * @param data The data to send
     */
    public boolean send(byte[] data) {
        OutputStream os = mOS;
        if (mbStart && os != null && !mbOtaUpdating) {
            Log.d(TAG, ">>> sending " + data.length + " bytes");
            return writeAllToSerial(os, data, "data");
        } else {
            if (mbOtaUpdating) {
                Log.d(TAG, "Cannot send data - BES OTA in progress");
            } else {
                Log.d(
                        TAG,
                        "Cannot send data - not started or output stream is null. mbStart="
                                + mbStart
                                + ", mOS="
                                + mOS);
            }
        }

        return false;
    }

    /**
     * Send file data over the serial port (without logging the data content) Blocked during BES OTA
     * updates
     *
     * @param data The file data to send
     * @return true if the write succeeded
     */
    public boolean sendFile(byte[] data) {
        OutputStream os = mOS;
        if (mbStart && os != null && !mbOtaUpdating) {
            // Don't log file data content, just write it
            return writeAllToSerial(os, data, "file");
        } else {
            if (mbOtaUpdating) {
                Log.d(TAG, "Cannot send file - BES OTA in progress");
            } else {
                Log.d(
                        TAG,
                        "Cannot send file - not started or output stream is null. mbStart="
                                + mbStart
                                + ", mOS="
                                + mOS);
            }
        }
        return false;
    }

    /**
     * Set fast mode for file transfers
     *
     * @param bFast true to enable fast mode (5ms sleep), false for normal mode (50ms sleep)
     */
    public void setFastMode(boolean bFast) {
        mbRequestFast = bFast;
        Log.d(TAG, "Fast mode " + (bFast ? "enabled" : "disabled"));
    }

    /**
     * Set BES OTA updating state When true, normal UART traffic is blocked and only OTA commands
     * pass through
     *
     * @param bOtaUpdate true to enable OTA mode, false to return to normal mode
     */
    public void setOtaUpdating(boolean bOtaUpdate) {
        mbOtaUpdating = bOtaUpdate;
        Log.d(TAG, "BES OTA updating: " + mbOtaUpdating);
    }

    /**
     * Send OTA command data over UART Only works when mbOtaUpdating is true
     *
     * @param data The OTA command data to send
     * @return true if sent successfully, false otherwise
     */
    public boolean sendOta(byte[] data) {
        OutputStream os = mOS;
        if (mbStart && os != null && mbOtaUpdating) {
            return writeAllToSerial(os, data, "OTA data");
        } else {
            Log.e(
                    TAG,
                    "Cannot send OTA data - mbStart="
                            + mbStart
                            + ", mOS="
                            + mOS
                            + ", mbOtaUpdating="
                            + mbOtaUpdating);
        }
        return false;
    }

    /** Thread for receiving data from the serial port */
    class RecvThread extends Thread {
        private boolean mbStop = false;

        public RecvThread() {}

        public void setStop() {
            mbStop = true;
        }

        @Override
        public void run() {
            int readSize;

            while (!mbStop) {
                InputStream is = mIS;
                if (is != null) {
                    try {
                        readSize = is.read(mReadBuf);
                        if (readSize > 0) {
                            // Route data based on OTA state
                            if (mbOtaUpdating) {
                                if (mOtaListener != null) {
                                    mOtaListener.onOtaRecv(mReadBuf, readSize);
                                }
                            } else {
                                if (mListener != null) {
                                    mListener.onSerialRead(COM_PATH, mReadBuf, readSize);
                                }
                            }
                        }
                    } catch (IOException e) {
                        Log.e(TAG, "Error reading from serial port", e);
                    }
                }

                try {
                    // Use fast mode (5ms) for file transfers, normal mode (50ms) otherwise
                    // Note: Original K900_server_sdk used 150ms, but K900Server_common uses
                    // 50ms/5ms
                    Thread.sleep(mbRequestFast ? 5 : 50);
                } catch (InterruptedException e) {
                    Log.e(TAG, "RecvThread interrupted", e);
                    break;
                }
            }

            Log.d(TAG, "RecvThread exiting");
        }
    }
}
