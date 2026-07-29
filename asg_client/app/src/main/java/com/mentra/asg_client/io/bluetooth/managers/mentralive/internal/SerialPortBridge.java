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
     * Start the serial communication
     *
     * @return true if started successfully, false otherwise
     */
    public synchronized boolean start() {
        if (mbStart) return true;
        if (mRecvThread != null) {
            closeCurrentPort();
        }

        boolean bSucc = SerialManager.getInstance().openSerial(COM_PATH, COM_BAUDRATE);
        Log.d(TAG, "openSerial dev=" + COM_PATH + ", bSucc=" + bSucc);

        if (mListener != null) mListener.onSerialOpen(bSucc, 0, COM_PATH, "");

        if (bSucc) {
            mbStart = true;
            mCurrentBaud = COM_BAUDRATE;
            mIS = SerialManager.getInstance().getInputStream(COM_PATH);
            mOS = SerialManager.getInstance().getOutputStream(COM_PATH);

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

        if (mbStart || mRecvThread != null) {
            closeCurrentPort();
        }

        if (!openDriverAtBaud(baud)) {
            Log.e(BAUD_TAG, "Serial port could not be opened at " + baud);
            return null;
        }

        mCurrentBaud = baud;
        mIS = SerialManager.getInstance().getInputStream(COM_PATH);
        mOS = SerialManager.getInstance().getOutputStream(COM_PATH);
        mbStart = true;

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

    /** Close the descriptor and retire its reader before another stream is published. */
    private void closeCurrentPort() {
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

        try {
            SerialManager.getInstance().closeSerial(COM_PATH);
        } catch (Exception e) {
            Log.e(BAUD_TAG, "Error closing serial port", e);
        }

        // The session retirement above waits for an already-entered listener callback. The old
        // reader therefore cannot cross the descriptor replacement, and stop prevents another
        // completed native read from being delivered or another read from starting.
        if (oldThread != null) {
            oldThread.interrupt();
        }
        mRecvThread = null;
    }

    /** Open COM_PATH at the given baud, catching any exception. */
    private boolean openDriverAtBaud(int baud) {
        try {
            boolean bSucc = SerialManager.getInstance().openSerial(COM_PATH, baud);
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

            Log.d(TAG, "RecvThread exiting");
        }
    }
}
