package com.augmentos.asg_client.bluetooth;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.util.Log;

/**
 * Factory class to create the appropriate bluetooth manager implementation
 * based on the device type.
 */
public class BluetoothManagerFactory {
    private static final String TAG = "BluetoothManagerFactory";

    /**
     * Get a bluetooth manager implementation based on the device type
     * @param context The application context
     * @return An implementation of IBluetoothManager appropriate for the device
     */
    public static IBluetoothManager getBluetoothManager(Context context) {
        Context appContext = context.getApplicationContext();
        
        // Switched back to StandardBluetoothManager due to issues with NordicBluetoothManager
        //Log.i(TAG, "Using StandardBluetoothManager instead of NordicBluetoothManager");
        //Log.i(TAG, "Implementation class: " + StandardBluetoothManager.class.getName());
        //return new StandardBluetoothManager(appContext);
        

        if (isK900Device(appContext)) {
            Log.i(TAG, "Creating K900BluetoothManager - K900 device detected");
            return new K900BluetoothManager(appContext);
        } else {
            Log.i(TAG, "Creating StandardBluetoothManager - standard device detected");
            return new StandardBluetoothManager(appContext);
        }

    }
    
    /**
     * Check if the device is a K900
     * @param context The application context
     * @return true if the device is a K900, false otherwise
     */
    private static boolean isK900Device(Context context) {
        // This method should be in sync with NetworkManagerFactory's implementation
        // Check for K900-specific broadcast receivers
        try {
            // Verify the SystemUI package exists
            PackageManager pm = context.getPackageManager();
            pm.getPackageInfo("com.android.systemui", 0);
            
            // Check for K900-specific system action
            try {
                // Set up a result receiver to check if our probe was received
                final boolean[] responseReceived = {false};
                BroadcastReceiver testReceiver = new BroadcastReceiver() {
                    @Override
                    public void onReceive(Context context, Intent intent) {
                        responseReceived[0] = true;
                        try {
                            context.unregisterReceiver(this);
                        } catch (Exception e) {
                            // Ignore unregister failures
                        }
                    }
                };
                
                // Register for any response from our probe
                context.registerReceiver(testReceiver, 
                        new IntentFilter("com.xy.xsetting.response"));
                
                // Send a test probe
                Intent testIntent = new Intent("com.xy.xsetting.action");
                testIntent.setPackage("com.android.systemui");
                testIntent.putExtra("cmd", "test_k900");
                context.sendBroadcast(testIntent);
                
                // In a real implementation, we would wait for a response
                // For now, we check device model as a fallback
                String model = android.os.Build.MODEL.toLowerCase();
                return model.contains("k900") || model.contains("xyglasses");
            } catch (Exception e) {
                Log.e(TAG, "Error checking for K900 specific broadcast", e);
            }
        } catch (Exception e) {
            Log.d(TAG, "Not a K900 device: " + e.getMessage());
        }
        
        return false;
    }
}