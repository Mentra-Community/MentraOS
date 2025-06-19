package com.augmentos.asg_client.bluetooth.serial;

import android.content.Context;
import android.util.Log;

import com.lhs.serialport.api.SerialManager;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Arrays;

/**
 * Manager for serial communication with the BES2700 Bluetooth module in K900 devices.
 */
public class ComManager {
    private static final String TAG = "ComManager";
    
    // Serial port configuration - matches the K900 SDK
    private static final String COM_PATH = "/dev/ttyS1";
    private static final int COM_BAUDRATE = 460800;
    
    private SerialListener mListener;
    private RecvThread mRecvThread = null;
    private byte[] mReadBuf = new byte[1024];
    private boolean mbStart = false;
    protected OutputStream mOS;
    protected InputStream mIS;
    private Context mContext = null;

    /**
     * Create a new ComManager
     * @param context The application context
     */
    public ComManager(Context context) {
        mContext = context;
    }
    
    /**
     * Register a listener for serial events
     * @param listener The listener to register
     */
    public void registerListener(SerialListener listener) { 
        mListener = listener; 
    }
    
    /**
     * Start the serial communication
     * @return true if started successfully, false otherwise
     */
    public boolean start() {
        if(mbStart)
            return true;
            
        boolean bSucc = SerialManager.getInstance().openSerial(COM_PATH, COM_BAUDRATE);
        Log.d(TAG, "openSerial dev=" + COM_PATH + ", bSucc=" + bSucc);
        
        if(mListener != null)
            mListener.onSerialOpen(bSucc, 0, COM_PATH, "");
            
        if(bSucc) {
            mbStart = true;
            mIS = SerialManager.getInstance().getInputStream(COM_PATH);
            mOS = SerialManager.getInstance().getOutputStream(COM_PATH);
            
            if(mRecvThread != null) {
                mRecvThread.setStop();
                mRecvThread = null;
            }
            
            mRecvThread = new RecvThread();
            mRecvThread.start();
            
            if(mListener != null)
                mListener.onSerialReady(COM_PATH);
        }
        
        return bSucc;
    }

    /**
     * Stop the serial communication
     */
    public void stop() {
        if(mbStart) {
            Log.d(TAG, "ComManager stopping");
            if(mRecvThread != null) {
                mRecvThread.setStop();
                mRecvThread.interrupt();
                mRecvThread = null;
            }
            SerialManager.getInstance().closeSerial(COM_PATH);
            mbStart = false;
            
            if(mListener != null)
                mListener.onSerialClose(COM_PATH);
                
            Log.d(TAG, "ComManager stopped");
        }
    }
    
    /**
     * Send data over the serial port
     * @param data The data to send
     */
    public void send(byte[] data) {
        if(mbStart && mOS != null) {
            try {
                Log.d(TAG, ">>> sending " + data.length + " bytes");
                mOS.write(data);
                mOS.flush();
            } catch (IOException e) {
                Log.e(TAG, "Error writing to serial port: " + e.getMessage());
            }
        } else {
            Log.d(TAG, "Cannot send data - not started or output stream is null. mbStart=" + mbStart + ", mOS=" + mOS);
        }
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
            
            while(!mbStop) {
                if(mIS != null) {
                    try {
                        readSize = mIS.read(mReadBuf);
                        if(readSize > 0) {
                            // Simple log with byte count only
                            Log.d(TAG, "UART read: " + readSize + " bytes");
                            
                            if(mListener != null)
                                mListener.onSerialRead(COM_PATH, mReadBuf, readSize);
                        }
                    } catch (IOException e) {
                        Log.e(TAG, "Error reading from serial port", e);
                    }
                }
                
                try {
                    // Keeping original 150ms sleep time to match K900_server_sdk
                    Thread.sleep(150);
                } catch (InterruptedException e) {
                    Log.e(TAG, "RecvThread interrupted", e);
                    break;
                }
            }
            
            Log.d(TAG, "RecvThread exiting");
        }
    }
}