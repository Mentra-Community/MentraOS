package com.mentra.asg_client.io.bluetooth.managers.mentralive.internal;

import android.content.Context;
import android.util.Log;
import com.lhs.serialport.api.SerialManager;
import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.io.bluetooth.interfaces.SerialListener;
import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.io.OutputStream;

/** Manager for serial communication with the BES2700 Bluetooth module in K900 devices. */
public class SerialPortBridge {
    private static final String TAG = "SerialPortBridge";

    /** Maximum time to wait for a closed descriptor's reader to terminate. */
    private static final long READER_STOP_TIMEOUT_MS = 1000;

    // Serial port configuration - matches the K900 SDK
    private static final String COM_PATH = "/dev/ttyS1";

    /** Default UART baud rate. The BES2700 always boots (and reverts) to this rate. */
    public static final int DEFAULT_BAUDRATE = AsgConstants.UART_RENDEZVOUS_BAUD;

    private static final int COM_BAUDRATE = DEFAULT_BAUDRATE;

    /** Log tag for runtime baud switching so the negotiation is easy to grep. */
    private static final String BAUD_TAG = "BAUD-SWITCH";

    private SerialListener mListener;
    private RecvThread mRecvThread = null;
    private volatile boolean mbStart = false;
    // volatile + snapshot-before-use: openAtBaud() nulls these on the baud-switch
    // thread while send/recv threads are mid-call. A stale stream throws a
    // handled IOException; a raw field read after the null-check would NPE.
    protected volatile OutputStream mOS;
    protected volatile InputStream mIS;
    private Context mContext = null;
    private volatile boolean mbRequestFast = false;
    private long nextSessionId = 0;
    private volatile SerialSession currentSession;
    private final SerialDriver serialDriver;
    private final long readerStopTimeoutMs;

    /** True only when no native descriptor from the previous session can be reused by a reader. */
    private boolean lastCloseSafe = true;

    /** Baud rate the port is currently open at (DEFAULT_BAUDRATE until a reopen succeeds). */
    private volatile int mCurrentBaud = DEFAULT_BAUDRATE;

    /**
     * Create a new SerialPortBridge
     *
     * @param context The application context
     */
    public SerialPortBridge(Context context) {
        this(context, new LhsSerialDriver(), READER_STOP_TIMEOUT_MS);
    }

    SerialPortBridge(Context context, SerialDriver serialDriver, long readerStopTimeoutMs) {
        mContext = context;
        this.serialDriver = serialDriver;
        this.readerStopTimeoutMs = readerStopTimeoutMs;
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
     * Start the serial communication
     *
     * @return true if started successfully, false otherwise
     */
    public synchronized boolean start() {
        if (mbStart) return true;
        if (!prepareForOpen()) {
            Log.e(TAG, "Refusing to start serial port while the previous reader is alive");
            return false;
        }

        boolean bSucc = serialDriver.open(COM_PATH, COM_BAUDRATE);
        Log.d(TAG, "openSerial dev=" + COM_PATH + ", bSucc=" + bSucc);

        if (mListener != null) mListener.onSerialOpen(bSucc, 0, COM_PATH, "");

        if (bSucc) {
            mbStart = true;
            lastCloseSafe = false;
            mCurrentBaud = COM_BAUDRATE;
            mIS = serialDriver.getInputStream(COM_PATH);
            mOS = serialDriver.getOutputStream(COM_PATH);

            SerialSession session = newSession(COM_BAUDRATE);
            currentSession = session;
            mRecvThread = new RecvThread(mIS, session);
            if (mListener != null) mListener.onSerialReady(COM_PATH, session);
            mRecvThread.start();
        }

        return bSucc;
    }

    /** Stop the serial communication */
    public synchronized void stop() {
        if (mbStart || mRecvThread != null) {
            Log.d(TAG, "SerialPortBridge stopping");
            closeCurrentPort();

            if (mListener != null) mListener.onSerialClose(COM_PATH);

            Log.d(TAG, "SerialPortBridge stopped");
        }
    }

    /**
     * Get the baud rate the serial port is currently open at.
     *
     * @return the current baud rate (DEFAULT_BAUDRATE unless openAtBaud() changed it)
     */
    public int getCurrentBaud() {
        return mCurrentBaud;
    }

    /**
     * Whether the serial port is currently open. Runtime baud replacement fires no serial callback,
     * so the transport owner must consult this after an open attempt.
     */
    public boolean isOpen() {
        return mbStart;
    }

    /** Identity of the current descriptor and reader, or {@code null} when closed. */
    public SerialSession getCurrentSession() {
        return currentSession;
    }

    /**
     * Replace /dev/ttyS1 at exactly the requested baud. This operation is also allowed after a
     * previous open failure left the descriptor closed. Listener registrations are preserved and no
     * serial callback is fired; transport state and fallback policy belong to the coordinator.
     *
     * @param baud The new baud rate (must be one of the rates supported by liblhsserial, e.g.
     *     460800, 921600, 1152000, 1500000, 2000000)
     * @return an unstarted session for the new descriptor, or {@code null} on failure
     */
    public synchronized SerialSession openAtBaud(int baud) {
        Log.i(
                BAUD_TAG,
                "Opening "
                        + COM_PATH
                        + " at "
                        + baud
                        + " (open="
                        + mbStart
                        + ", previousBaud="
                        + mCurrentBaud
                        + ")");

        if (!prepareForOpen()) {
            Log.e(
                    BAUD_TAG,
                    "Refusing to open "
                            + COM_PATH
                            + " at "
                            + baud
                            + " while the previous reader is alive");
            return null;
        }

        if (!openDriverAtBaud(baud)) {
            Log.e(BAUD_TAG, "Serial port could not be opened at " + baud);
            return null;
        }

        mCurrentBaud = baud;
        mIS = serialDriver.getInputStream(COM_PATH);
        mOS = serialDriver.getOutputStream(COM_PATH);
        mbStart = true;
        lastCloseSafe = false;

        SerialSession session = newSession(baud);
        currentSession = session;

        Log.i(BAUD_TAG, "Serial port opened at " + baud + " baud");
        return session;
    }

    /** Start the receive reader after the coordinator has adopted this session. */
    public synchronized boolean startReader(SerialSession session) {
        if (session == null
                || session != currentSession
                || !session.isActive()
                || !mbStart
                || mIS == null
                || mRecvThread != null) {
            Log.w(BAUD_TAG, "Cannot start reader for inactive or non-current session " + session);
            return false;
        }
        mRecvThread = new RecvThread(mIS, session);
        mRecvThread.start();
        return true;
    }

    /** Close the descriptor only if it still belongs to the supplied session. */
    public synchronized void closeSession(SerialSession session) {
        if (session != null && session == currentSession) {
            closeCurrentPort();
        } else if (session != null) {
            session.retire();
        }
    }

    private SerialSession newSession(int baud) {
        return new SerialSession(++nextSessionId, COM_PATH, baud);
    }

    /** Ensure no prior descriptor or reader remains before opening a new physical session. */
    private boolean prepareForOpen() {
        if (!mbStart && mRecvThread == null && lastCloseSafe) {
            return true;
        }
        return closeCurrentPort();
    }

    /**
     * Close the descriptor, then wait for its reader to terminate before allowing another open.
     *
     * <p>{@code liblhsserial} indexes streams by path. Reopening {@code /dev/ttyS1} while an old
     * {@link InputStream#read(byte[])} is still blocked can attach that old reader to the new
     * native descriptor. Interrupting a Java thread is not sufficient to unblock that native read.
     * The replacement must therefore fail closed unless descriptor close plus interruption actually
     * terminates the reader.
     */
    private boolean closeCurrentPort() {
        RecvThread oldThread = mRecvThread;
        if (oldThread != null) {
            oldThread.setStop();
        }
        SerialSession oldSession = currentSession;
        if (oldSession != null) {
            oldSession.retire();
        }
        mbStart = false;
        currentSession = null;
        mIS = null;
        mOS = null;

        boolean driverClosed = true;
        try {
            serialDriver.close(COM_PATH);
        } catch (Exception e) {
            driverClosed = false;
            Log.e(BAUD_TAG, "Error closing serial port", e);
        }

        boolean readerStopped = true;
        if (oldThread != null) {
            oldThread.interrupt();
            if (Thread.currentThread() == oldThread) {
                readerStopped = false;
                Log.e(BAUD_TAG, "Serial reader attempted to replace its own descriptor");
            } else {
                try {
                    oldThread.join(readerStopTimeoutMs);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    readerStopped = false;
                    Log.e(BAUD_TAG, "Interrupted while waiting for serial reader to stop", e);
                }
                if (oldThread.isAlive()) {
                    readerStopped = false;
                    Log.e(
                            BAUD_TAG,
                            "Serial reader did not exit within "
                                    + readerStopTimeoutMs
                                    + "ms; replacement is blocked for "
                                    + oldThread.session);
                }
            }
        }

        if (readerStopped) {
            mRecvThread = null;
        } else {
            // Retain ownership of the live reader so every later open attempt must close and wait
            // again. Never lose the only handle to a thread that can consume the next descriptor.
            mRecvThread = oldThread;
        }

        lastCloseSafe = driverClosed && readerStopped;
        return lastCloseSafe;
    }

    /** Open COM_PATH at the given baud, catching any exception. */
    private boolean openDriverAtBaud(int baud) {
        try {
            boolean bSucc = serialDriver.open(COM_PATH, baud);
            Log.d(BAUD_TAG, "openSerial dev=" + COM_PATH + " baud=" + baud + " bSucc=" + bSucc);
            return bSucc;
        } catch (Exception | LinkageError e) {
            Log.e(BAUD_TAG, "Exception opening serial at baud " + baud, e);
            return false;
        }
    }

    /**
     * Write all bytes to the serial port, draining EAGAIN. liblhsserial opens /dev/ttyS1 O_NONBLOCK
     * (verified by disassembly: open flags 0x902), so large bursts overrun the kernel's ~4KB tty TX
     * buffer and FileOutputStream.write throws EAGAIN after an UNKNOWN number of bytes already left
     * the process - corrupting the stream on retry. Os.write gives exact-byte accounting; on EAGAIN
     * we wait for the line to drain (~4KB at 1.152M is ~36ms) and continue from the precise offset.
     * This is what restores the "write blocks at line rate" pacing the push-mode file pump is
     * designed around.
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

    /** Write bytes to the currently open serial stream. Policy is owned by the coordinator. */
    public boolean write(byte[] data) {
        OutputStream os = mOS;
        if (mbStart && os != null) {
            return writeAllToSerial(os, data, "data");
        }
        Log.d(
                TAG,
                "Cannot write data - not started or output stream is null. mbStart="
                        + mbStart
                        + ", mOS="
                        + mOS);
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

    /** Thread for receiving data from the serial port */
    class RecvThread extends Thread {
        private final InputStream input;
        private final SerialSession session;
        private final byte[] readBuffer = new byte[1024];
        private volatile boolean mbStop = false;

        RecvThread(InputStream input, SerialSession session) {
            this.input = input;
            this.session = session;
        }

        public void setStop() {
            mbStop = true;
        }

        @Override
        public void run() {
            int readSize;

            Log.i(BAUD_TAG, "Serial reader started for " + session);

            while (!mbStop) {
                if (input != null) {
                    try {
                        readSize = input.read(readBuffer);
                        if (readSize > 0 && !mbStop) {
                            SerialListener listener = mListener;
                            if (listener != null) {
                                int callbackSize = readSize;
                                session.dispatch(
                                        () ->
                                                listener.onSerialRead(
                                                        COM_PATH,
                                                        readBuffer,
                                                        callbackSize,
                                                        session));
                            }
                        }
                    } catch (IOException e) {
                        if (!mbStop) {
                            Log.e(TAG, "Error reading from serial port", e);
                        }
                    }
                }

                try {
                    // Use fast mode (5ms) for file transfers, normal mode (50ms) otherwise
                    // Note: Original K900_server_sdk used 150ms, but K900Server_common uses
                    // 50ms/5ms
                    Thread.sleep(mbRequestFast ? 5 : 50);
                } catch (InterruptedException e) {
                    if (!mbStop) {
                        Log.e(TAG, "RecvThread interrupted", e);
                    }
                    break;
                }
            }

            Log.i(BAUD_TAG, "Serial reader exited for " + session);
        }
    }

    interface SerialDriver {
        boolean open(String path, int baud);

        InputStream getInputStream(String path);

        OutputStream getOutputStream(String path);

        void close(String path);
    }

    private static final class LhsSerialDriver implements SerialDriver {
        @Override
        public boolean open(String path, int baud) {
            return SerialManager.getInstance().openSerial(path, baud);
        }

        @Override
        public InputStream getInputStream(String path) {
            return SerialManager.getInstance().getInputStream(path);
        }

        @Override
        public OutputStream getOutputStream(String path) {
            return SerialManager.getInstance().getOutputStream(path);
        }

        @Override
        public void close(String path) {
            SerialManager.getInstance().closeSerial(path);
        }
    }
}
