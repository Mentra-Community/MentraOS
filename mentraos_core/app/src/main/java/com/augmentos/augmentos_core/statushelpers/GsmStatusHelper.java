package com.augmentos.augmentos_core.statushelpers;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.net.ConnectivityManager;
import android.net.NetworkInfo;
import android.telephony.CellInfo;
import android.telephony.CellInfoGsm;
import android.telephony.TelephonyManager;
import android.telephony.SignalStrength;
import android.util.Log;

import androidx.core.content.ContextCompat;

import java.util.List;

public class GsmStatusHelper {
    private static final String TAG = "GsmStatusHelper";
    private final TelephonyManager telephonyManager;
    private final Context context;

    public GsmStatusHelper(Context context) {
        this.context = context;
        this.telephonyManager = (TelephonyManager) context.getSystemService(Context.TELEPHONY_SERVICE);
    }

    private boolean hasPhoneStatePermission() {
        return ContextCompat.checkSelfPermission(context, Manifest.permission.READ_PHONE_STATE) 
                == PackageManager.PERMISSION_GRANTED;
    }

    public boolean isConnected() {
        // Try to use telephony manager if we have permission
        if (hasPhoneStatePermission()) {
            try {
                int networkType = telephonyManager.getNetworkType();
                return networkType != TelephonyManager.NETWORK_TYPE_UNKNOWN;
            } catch (Exception e) {
                Log.e(TAG, "Error checking network type with permission", e);
            }
        }
        
        // Fallback: Try to determine cellular connectivity using connectivity manager
        // This doesn't require READ_PHONE_STATE
        try {
            ConnectivityManager cm = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
            NetworkInfo netInfo = cm.getActiveNetworkInfo();
            return netInfo != null && (netInfo.getType() == ConnectivityManager.TYPE_MOBILE) && netInfo.isConnected();
        } catch (Exception e) {
            Log.e(TAG, "Error checking network connectivity", e);
            // If we can't determine, assume connected to avoid false negatives
            return true;
        }
    }

    public String getNetworkType() {
        if (hasPhoneStatePermission()) {
            try {
                int networkType = telephonyManager.getNetworkType();
                switch (networkType) {
                    case TelephonyManager.NETWORK_TYPE_GSM:
                        return "GSM";
                    case TelephonyManager.NETWORK_TYPE_LTE:
                        return "LTE";
                    case TelephonyManager.NETWORK_TYPE_UMTS:
                        return "UMTS";
                    case TelephonyManager.NETWORK_TYPE_HSDPA:
                        return "HSDPA";
                    case TelephonyManager.NETWORK_TYPE_HSUPA:
                        return "HSUPA";
                    case TelephonyManager.NETWORK_TYPE_HSPA:
                        return "HSPA";
                    case TelephonyManager.NETWORK_TYPE_EDGE:
                        return "EDGE";
                    case TelephonyManager.NETWORK_TYPE_CDMA:
                        return "CDMA";
                    case TelephonyManager.NETWORK_TYPE_1xRTT:
                        return "1xRTT";
                    case TelephonyManager.NETWORK_TYPE_IDEN:
                        return "iDEN";
                    case TelephonyManager.NETWORK_TYPE_EVDO_0:
                        return "EVDO rev. 0";
                    case TelephonyManager.NETWORK_TYPE_EVDO_A:
                        return "EVDO rev. A";
                    case TelephonyManager.NETWORK_TYPE_EVDO_B:
                        return "EVDO rev. B";
                    case TelephonyManager.NETWORK_TYPE_NR:
                        return "5G";
                    default:
                        return "Cellular";
                }
            } catch (Exception e) {
                Log.e(TAG, "Error getting network type", e);
            }
        }
        
        // Fallback: If we don't have permission or there was an error, provide a generic response
        if (isConnected()) {
            return "Cellular"; // Generic fallback if we know we're on cellular
        } else {
            return "Unknown";
        }
    }

    public int getSignalStrength() {
        if (hasPhoneStatePermission()) {
            try {
                SignalStrength signalStrength = telephonyManager.getSignalStrength();
                if (signalStrength != null) {
                    List<CellInfo> cellInfoList = telephonyManager.getAllCellInfo();
                    if (cellInfoList != null) {
                        for (CellInfo cellInfo : cellInfoList) {
                            if (cellInfo instanceof CellInfoGsm) {
                                CellInfoGsm cellInfoGsm = (CellInfoGsm) cellInfo;
                                return cellInfoGsm.getCellSignalStrength().getLevel() * 25; // Scale to 0-100%
                            }
                        }
                    }
                }
            } catch (Exception e) {
                Log.e(TAG, "Error getting signal strength", e);
            }
        }
        
        // Fallback: Return a medium signal strength as a default
        return 50; // Return medium (50%) signal strength as a fallback
    }
}
