package com.mentra.asg_client.io.bluetooth.core;

import android.content.Context;
import android.util.Log;

import com.lhs.serialport.api.SerialManager;
import com.mentra.asg_client.io.bluetooth.interfaces.SerialListener;
import com.mentra.asg_client.io.bes.BesOtaUartListener;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * Manager for serial communication with the BES2700 Bluetooth module in K900 devices.
 */
public class ComManager {
    private static final String TAG = "ComManager";

    // Serial port configuration - matches the K900 SDK
    private static final String COM_PATH = "/dev/ttyS1";
    private static final int COM_BAUDRATE = 460800;

    private SerialListener mListener;
    private BesOtaUartListener mOtaListener;
    private RecvThread mRecvThread = null;
    private byte[] mReadBuf = new byte[1024];
    private boolean mbStart = false;
    protected OutputStream mOS;
    protected InputStream mIS;
    private Context mContext = null;
    private boolean mbRequestFast = false;
    public boolean mbOtaUpdating = false;

    /**
     * Create a new ComManager
     *
     * @param context The application context
     */
    public ComManager(Context context) {
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
        if (mbStart)
            return true;

        boolean bSucc = SerialManager.getInstance().openSerial(COM_PATH, COM_BAUDRATE);
        Log.d(TAG, "openSerial dev=" + COM_PATH + ", bSucc=" + bSucc);

        if (mListener != null)
            mListener.onSerialOpen(bSucc, 0, COM_PATH, "");

        if (bSucc) {
            mbStart = true;
            mIS = SerialManager.getInstance().getInputStream(COM_PATH);
            mOS = SerialManager.getInstance().getOutputStream(COM_PATH);

            if (mRecvThread != null) {
                mRecvThread.setStop();
                mRecvThread = null;
            }

            mRecvThread = new RecvThread();
            mRecvThread.start();

            if (mListener != null)
                mListener.onSerialReady(COM_PATH);
        }

        return bSucc;
    }

    /**
     * Stop the serial communication
     */
    public void stop() {
        if (mbStart) {
            Log.d(TAG, "ComManager stopping");
            if (mRecvThread != null) {
                mRecvThread.setStop();
                mRecvThread.interrupt();
                mRecvThread = null;
            }
            SerialManager.getInstance().closeSerial(COM_PATH);
            mbStart = false;

            if (mListener != null)
                mListener.onSerialClose(COM_PATH);

            Log.d(TAG, "ComManager stopped");
        }
    }

    /**
     * Send data over the serial port
     * Blocked during BES OTA updates
     *
     * @param data The data to send
     */
    public boolean send(byte[] data) {
        if (mbStart && mOS != null && !mbOtaUpdating) {
            try {
                Log.d(TAG, ">>> sending " + data.length + " bytes");
                mOS.write(data);
                mOS.flush();

                return true;
            } catch (IOException e) {
                Log.e(TAG, "Error writing to serial port: " + e.getMessage());
            }
        } else {
            if (mbOtaUpdating) {
                Log.d(TAG, "Cannot send data - BES OTA in progress");
            } else {
                Log.d(TAG, "Cannot send data - not started or output stream is null. mbStart=" + mbStart + ", mOS=" + mOS);
            }
        }

        return false;
    }

    /**
     * Send file data over the serial port (without logging the data content)
     * Blocked during BES OTA updates
     *
     * @param data The file data to send
     */
    public void sendFile(byte[] data) {
        if (mbStart && mOS != null && !mbOtaUpdating) {
            try {
                // Don't log file data content, just write it
                mOS.write(data);
                mOS.flush();
            } catch (IOException e) {
                Log.e(TAG, "Error writing file to serial port: " + e.getMessage());
            }
        } else {
            if (mbOtaUpdating) {
                Log.d(TAG, "Cannot send file - BES OTA in progress");
            } else {
                Log.d(TAG, "Cannot send file - not started or output stream is null. mbStart=" + mbStart + ", mOS=" + mOS);
            }
        }
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
     * Set BES OTA updating state
     * When true, normal UART traffic is blocked and only OTA commands pass through
     *
     * @param bOtaUpdate true to enable OTA mode, false to return to normal mode
     */
    public void setOtaUpdating(boolean bOtaUpdate) {
        mbOtaUpdating = bOtaUpdate;
        Log.d(TAG, "BES OTA updating: " + mbOtaUpdating);
    }

    /**
     * Send OTA command data over UART
     * Only works when mbOtaUpdating is true
     *
     * @param data The OTA command data to send
     * @return true if sent successfully, false otherwise
     */
    public boolean sendOta(byte[] data) {
        if (mbStart && mOS != null && mbOtaUpdating) {
            try {
                mOS.write(data);
                mOS.flush();
                return true;
            } catch (IOException e) {
                Log.e(TAG, "Error writing OTA data to serial port: " + e.getMessage());
            }
        } else {
            Log.e(TAG, "Cannot send OTA data - mbStart=" + mbStart + ", mOS=" + mOS + ", mbOtaUpdating=" + mbOtaUpdating);
        }
        return false;
    }


    /**
     * Thread for receiving data from the serial port
     */
    class RecvThread extends Thread {
        private boolean mbStop = false;

        public RecvThread() {
        }

        public void setStop() {
            mbStop = true;
        }

        @Override
        public void run() {
            int readSize;

            while (!mbStop) {
                if (mIS != null) {
                    try {
                        readSize = mIS.read(mReadBuf);
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
                    // Note: Original K900_server_sdk used 150ms, but K900Server_common uses 50ms/5ms
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