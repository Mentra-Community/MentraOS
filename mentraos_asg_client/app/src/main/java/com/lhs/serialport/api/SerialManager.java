package com.lhs.serialport.api;
import android.util.Log;

import com.xy.kssdk.util.SkConst;

import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;

/**
 * Manager for serial port connections from K900 SDK.
 */
public class SerialManager {
    private static final String TAG = "SerialManager";
    
    private ArrayList<SerialPort> mSerialList = null;
    private static SerialManager instance;
    
    private SerialManager() {
        mSerialList = new ArrayList<>();
    }
    
    public static synchronized SerialManager getInstance() {
        if (instance == null) {
            instance = new SerialManager();
        }
        return instance;
    }

    public boolean openSerial(String devPath, int baudrate) {
        if(devPath == null)
            return false;
            
        for(SerialPort sp: mSerialList) {
            if(devPath.equals(sp.getDevPath())) {
                return true;
            }
        }
        
        SerialPort sp = new SerialPort(devPath, baudrate, 0);
        boolean bSucc = sp.openSerial();
        Log.d(TAG, "openSerial bSucc=" + bSucc);
        
        if(bSucc)
            mSerialList.add(sp);
            
        return bSucc;
    }

    public InputStream getInputStream(String devPath) {
        if(devPath == null)
            return null;
            
        for(SerialPort sp: mSerialList) {
            if(devPath.equals(sp.getDevPath())) {
                return sp.getInputStream();
            }
        }
        
        return null;
    }
    
    public OutputStream getOutputStream(String devPath) {
        if(devPath == null)
            return null;
            
        for(SerialPort sp: mSerialList) {
            if(devPath.equals(sp.getDevPath())) {
                return sp.getOutputStream();
            }
        }
        
        return null;
    }

    public void closeSerial(String devPath) {
        if(devPath == null)
            return;
            
        for(SerialPort sp: mSerialList) {
            if(devPath.equals(sp.getDevPath())) {
                sp.closeSerial();
                mSerialList.remove(sp);
                return;
            }
        }
    }
}