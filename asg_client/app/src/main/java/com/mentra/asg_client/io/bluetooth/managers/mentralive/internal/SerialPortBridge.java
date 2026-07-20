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
    private volatile boolean mbOtaUpdating = false;

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

    /** Whether BES OTA currently owns UART receive routing. */
    public boolean isOtaUpdating() {
        return mbOtaUpdating;
    }

    /** Notify the normal UART owner that BES accepted an OTA image and is rebooting. */
    public void notifyBesOtaApplied() {
        SerialListener listener = mListener;
        if (listener != null) {
            listener.onBesOtaApplied();
        }
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
            if (Log.isLoggable(TAG, Log.VERBOSE)) {
                Log.v(TAG, ">>> sending " + data.length + " bytes");
            }
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
            // Prefer Os.poll so inbound ACKs are noticed immediately. liblhsserial opens
            // /dev/ttyS1 O_NONBLOCK, so the old Thread.sleep(5/50) after every read added
            // up to that much dead time before Mentra could turn an ACK around.
            SerialReceiveWait receiveWait =
                    SerialReceiveWait.forInputStream(mIS, () -> mbRequestFast);
            InputStream waitBoundTo = mIS;

            while (!mbStop) {
                InputStream is = mIS;
                if (is != waitBoundTo) {
                    receiveWait = SerialReceiveWait.forInputStream(is, () -> mbRequestFast);
                    waitBoundTo = is;
                }
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
                            // Data was available — loop immediately without sleeping.
                            continue;
                        }
                    } catch (IOException e) {
                        Log.e(TAG, "Error reading from serial port", e);
                    }
                }

                try {
                    receiveWait.await();
                } catch (InterruptedException e) {
                    Log.e(TAG, "RecvThread interrupted", e);
                    break;
                }
            }

            Log.d(TAG, "RecvThread exiting");
        }
    }
}
