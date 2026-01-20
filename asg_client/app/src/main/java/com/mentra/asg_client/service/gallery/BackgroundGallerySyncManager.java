package com.mentra.asg_client.service.gallery;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.os.BatteryManager;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import androidx.preference.PreferenceManager;

import com.mentra.asg_client.service.system.interfaces.IStateManager;

/**
 * Background Gallery Sync Manager
 * Monitors charging and WiFi state to trigger automatic cloud uploads
 * 
 * Triggers cloud sync when:
 * - Device is charging
 * - Connected to WiFi
 * - Background sync is enabled in settings
 * - No conflicting WiFi Direct sync is active
 */
public class BackgroundGallerySyncManager {
    private static final String TAG = "BackgroundGallerySyncManager";
    
    // Settings keys
    private static final String PREF_ENABLE_BACKGROUND_SYNC = "enable_background_gallery_sync";
    private static final String PREF_CLOUD_SYNC_WIFI_ONLY = "cloud_sync_wifi_only";
    private static final String PREF_CLOUD_SYNC_MIN_BATTERY = "cloud_sync_min_battery";
    private static final String PREF_LAST_CLOUD_SYNC_TIME = "last_cloud_sync_timestamp";
    
    // Timing constants
    private static final long SYNC_DEBOUNCE_MS = 5000; // Wait 5s after conditions met before starting
    private static final long CONDITION_CHECK_INTERVAL_MS = 60000; // Check conditions every 60s
    
    private final Context mContext;
    private final IStateManager mStateManager;
    private final CloudGalleryUploader mCloudUploader;
    private final SharedPreferences mPrefs;
    private final Handler mHandler;
    
    private BroadcastReceiver mBatteryReceiver;
    private BroadcastReceiver mWifiReceiver;
    private boolean mIsMonitoring = false;
    private Runnable mSyncDebounceRunnable;
    private Runnable mPeriodicCheckRunnable;
    
    // State tracking
    private boolean mLastChargingState = false;
    private boolean mLastWifiState = false;
    
    public BackgroundGallerySyncManager(Context context, IStateManager stateManager, 
                                       CloudGalleryUploader cloudUploader) {
        this.mContext = context;
        this.mStateManager = stateManager;
        this.mCloudUploader = cloudUploader;
        this.mPrefs = PreferenceManager.getDefaultSharedPreferences(context);
        this.mHandler = new Handler(Looper.getMainLooper());
        
        Log.i(TAG, "🔄 BackgroundGallerySyncManager initialized");
    }
    
    /**
     * Start monitoring charging and WiFi state
     */
    public void startMonitoring() {
        if (mIsMonitoring) {
            Log.d(TAG, "Already monitoring");
            return;
        }
        
        Log.i(TAG, "🔄 Starting background sync monitoring");
        
        // Register battery receiver
        mBatteryReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                handleBatteryStateChange(intent);
            }
        };
        
        IntentFilter batteryFilter = new IntentFilter();
        batteryFilter.addAction(Intent.ACTION_BATTERY_CHANGED);
        batteryFilter.addAction(Intent.ACTION_POWER_CONNECTED);
        batteryFilter.addAction(Intent.ACTION_POWER_DISCONNECTED);
        mContext.registerReceiver(mBatteryReceiver, batteryFilter);
        
        // Register WiFi receiver
        mWifiReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                handleWifiStateChange();
            }
        };
        
        IntentFilter wifiFilter = new IntentFilter();
        wifiFilter.addAction(ConnectivityManager.CONNECTIVITY_ACTION);
        mContext.registerReceiver(mWifiReceiver, wifiFilter);
        
        mIsMonitoring = true;
        
        // Check conditions immediately
        checkConditionsAndScheduleSync();
        
        // Start periodic condition checks
        startPeriodicChecks();
        
        Log.i(TAG, "✅ Background sync monitoring started");
    }
    
    /**
     * Stop monitoring
     */
    public void stopMonitoring() {
        if (!mIsMonitoring) {
            return;
        }
        
        Log.i(TAG, "🛑 Stopping background sync monitoring");
        
        try {
            if (mBatteryReceiver != null) {
                mContext.unregisterReceiver(mBatteryReceiver);
                mBatteryReceiver = null;
            }
        } catch (Exception e) {
            Log.w(TAG, "Error unregistering battery receiver", e);
        }
        
        try {
            if (mWifiReceiver != null) {
                mContext.unregisterReceiver(mWifiReceiver);
                mWifiReceiver = null;
            }
        } catch (Exception e) {
            Log.w(TAG, "Error unregistering WiFi receiver", e);
        }
        
        // Cancel any pending sync
        if (mSyncDebounceRunnable != null) {
            mHandler.removeCallbacks(mSyncDebounceRunnable);
            mSyncDebounceRunnable = null;
        }
        
        // Cancel periodic checks
        if (mPeriodicCheckRunnable != null) {
            mHandler.removeCallbacks(mPeriodicCheckRunnable);
            mPeriodicCheckRunnable = null;
        }
        
        mIsMonitoring = false;
        Log.i(TAG, "✅ Background sync monitoring stopped");
    }
    
    /**
     * Handle battery state change
     */
    private void handleBatteryStateChange(Intent intent) {
        int status = intent.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
        boolean isCharging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
                           status == BatteryManager.BATTERY_STATUS_FULL;
        
        // Only log if state changed
        if (isCharging != mLastChargingState) {
            Log.d(TAG, "🔋 Charging state changed: " + (isCharging ? "CHARGING" : "NOT CHARGING"));
            mLastChargingState = isCharging;
            checkConditionsAndScheduleSync();
        }
    }
    
    /**
     * Handle WiFi state change
     */
    private void handleWifiStateChange() {
        boolean isWifiConnected = mStateManager.isConnectedToWifi();
        
        // Only log if state changed
        if (isWifiConnected != mLastWifiState) {
            Log.d(TAG, "📶 WiFi state changed: " + (isWifiConnected ? "CONNECTED" : "DISCONNECTED"));
            mLastWifiState = isWifiConnected;
            checkConditionsAndScheduleSync();
        }
    }
    
    /**
     * Start periodic condition checks (every 60 seconds)
     * This catches state changes we might have missed from broadcast receivers
     */
    private void startPeriodicChecks() {
        if (mPeriodicCheckRunnable != null) {
            mHandler.removeCallbacks(mPeriodicCheckRunnable);
        }
        
        mPeriodicCheckRunnable = new Runnable() {
            @Override
            public void run() {
                if (mIsMonitoring) {
                    checkConditionsAndScheduleSync();
                    mHandler.postDelayed(this, CONDITION_CHECK_INTERVAL_MS);
                }
            }
        };
        
        mHandler.postDelayed(mPeriodicCheckRunnable, CONDITION_CHECK_INTERVAL_MS);
    }
    
    /**
     * Check if all conditions are met for sync and schedule if ready
     */
    private void checkConditionsAndScheduleSync() {
        boolean isCharging = mStateManager.isCharging();
        boolean isWifiConnected = mStateManager.isConnectedToWifi();
        boolean syncEnabled = mPrefs.getBoolean(PREF_ENABLE_BACKGROUND_SYNC, true);
        boolean wifiOnly = mPrefs.getBoolean(PREF_CLOUD_SYNC_WIFI_ONLY, true);
        int minBattery = mPrefs.getInt(PREF_CLOUD_SYNC_MIN_BATTERY, 20);
        int currentBattery = mStateManager.getBatteryLevel();
        
        Log.d(TAG, "📊 Condition check: charging=" + isCharging + 
                  ", wifi=" + isWifiConnected + 
                  ", enabled=" + syncEnabled + 
                  ", battery=" + currentBattery + "% (min: " + minBattery + "%)");
        
        // Check all conditions
        boolean conditionsMet = syncEnabled &&
                              isCharging &&
                              (currentBattery >= minBattery || currentBattery == -1) && // -1 means unknown
                              (!wifiOnly || isWifiConnected);
        
        if (conditionsMet) {
            scheduleSync();
        } else {
            // Conditions not met - cancel any pending sync
            if (mSyncDebounceRunnable != null) {
                Log.d(TAG, "❌ Conditions no longer met - cancelling pending sync");
                mHandler.removeCallbacks(mSyncDebounceRunnable);
                mSyncDebounceRunnable = null;
            }
            
            // Stop any active upload
            if (mCloudUploader.isUploading()) {
                Log.i(TAG, "⏸️ Conditions no longer met - pausing active upload");
                mCloudUploader.pauseUpload();
            }
        }
    }
    
    /**
     * Schedule sync with debounce (waits 5 seconds to avoid rapid triggers)
     */
    private void scheduleSync() {
        // Cancel existing debounce if any
        if (mSyncDebounceRunnable != null) {
            mHandler.removeCallbacks(mSyncDebounceRunnable);
        }
        
        Log.d(TAG, "⏱️ Scheduling sync in " + (SYNC_DEBOUNCE_MS / 1000) + " seconds");
        
        mSyncDebounceRunnable = new Runnable() {
            @Override
            public void run() {
                onConditionsMetForSync();
            }
        };
        
        mHandler.postDelayed(mSyncDebounceRunnable, SYNC_DEBOUNCE_MS);
    }
    
    /**
     * Triggered when all conditions are met for sync (after debounce)
     */
    private void onConditionsMetForSync() {
        Log.i(TAG, "✅ All conditions met for background sync");
        
        // Check if already uploading
        if (mCloudUploader.isUploading()) {
            Log.d(TAG, "Already uploading - continuing existing sync");
            return;
        }
        
        // Start the upload
        Log.i(TAG, "🚀 Starting cloud gallery upload");
        mCloudUploader.startUpload();
        
        // Update last sync time
        mPrefs.edit()
            .putLong(PREF_LAST_CLOUD_SYNC_TIME, System.currentTimeMillis())
            .apply();
    }
    
    /**
     * Check if background sync is enabled
     */
    public boolean isBackgroundSyncEnabled() {
        return mPrefs.getBoolean(PREF_ENABLE_BACKGROUND_SYNC, true);
    }
    
    /**
     * Enable or disable background sync
     */
    public void setBackgroundSyncEnabled(boolean enabled) {
        mPrefs.edit()
            .putBoolean(PREF_ENABLE_BACKGROUND_SYNC, enabled)
            .apply();
        
        Log.i(TAG, "Background sync " + (enabled ? "enabled" : "disabled"));
        
        if (!enabled && mCloudUploader.isUploading()) {
            Log.i(TAG, "Pausing active upload due to setting change");
            mCloudUploader.pauseUpload();
        } else if (enabled) {
            checkConditionsAndScheduleSync();
        }
    }
    
    /**
     * Get last sync timestamp
     */
    public long getLastSyncTime() {
        return mPrefs.getLong(PREF_LAST_CLOUD_SYNC_TIME, 0);
    }
    
    /**
     * Force an immediate sync check (for testing/debugging)
     */
    public void forceSync() {
        Log.i(TAG, "🔨 Force sync requested");
        onConditionsMetForSync();
    }
}
