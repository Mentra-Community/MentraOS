package com.mentra.asg_client.service.gallery;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import androidx.preference.PreferenceManager;

import com.mentra.asg_client.events.BatteryStatusEvent;
import com.mentra.asg_client.service.system.interfaces.IStateManager;
import com.mentra.asg_client.io.network.interfaces.INetworkManager;

import org.greenrobot.eventbus.EventBus;
import org.greenrobot.eventbus.Subscribe;
import org.greenrobot.eventbus.ThreadMode;

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
    
    // Feature flags - set to false to disable battery/charging checks
    private static final boolean REQUIRE_CHARGING = false; // Set to true to require charging
    private static final boolean REQUIRE_MIN_BATTERY = false; // Set to true to require minimum battery level
    
    private final Context mContext;
    private final IStateManager mStateManager;
    private final CloudGalleryUploader mCloudUploader;
    private final GalleryUploadQueue mUploadQueue;
    private final SharedPreferences mPrefs;
    private final Handler mHandler;
    private final INetworkManager mNetworkManager;
    
    private BroadcastReceiver mWifiReceiver;
    private boolean mIsMonitoring = false;
    private Runnable mSyncDebounceRunnable;
    private Runnable mPeriodicCheckRunnable;
    
    // State tracking
    private boolean mLastWifiState = false;
    private boolean mSyncInProgress = false; // Track if sync is currently running
    private boolean mHotspotEnabled = false; // Track hotspot state to block cloud uploads during WiFi Direct sync
    
    public BackgroundGallerySyncManager(Context context, IStateManager stateManager, 
                                       CloudGalleryUploader cloudUploader, GalleryUploadQueue uploadQueue,
                                       INetworkManager networkManager) {
        this.mContext = context;
        this.mStateManager = stateManager;
        this.mCloudUploader = cloudUploader;
        this.mUploadQueue = uploadQueue;
        this.mPrefs = PreferenceManager.getDefaultSharedPreferences(context);
        this.mHandler = new Handler(Looper.getMainLooper());
        this.mNetworkManager = networkManager;
        
        // Register as network state listener to track hotspot state
        if (mNetworkManager != null) {
            mNetworkManager.addWifiListener(new com.mentra.asg_client.io.network.interfaces.NetworkStateListener() {
                @Override
                public void onWifiStateChanged(boolean isConnected) {
                    // Not used
                }
                
                @Override
                public void onHotspotStateChanged(boolean isEnabled) {
                    mHotspotEnabled = isEnabled;
                    Log.i(TAG, "🔥 Hotspot state changed: " + (isEnabled ? "ENABLED" : "DISABLED") + 
                              " - " + (isEnabled ? "cancelling cloud uploads" : "resuming cloud upload check"));
                    
                    // If hotspot enabled (WiFi Direct sync active), cancel any active uploads
                    if (isEnabled && mCloudUploader.isUploading()) {
                        Log.i(TAG, "🛑 Cancelling cloud upload due to WiFi Direct sync (hotspot enabled)");
                        mCloudUploader.cancelUpload();
                        mSyncInProgress = false; // Reset sync state since we cancelled
                    }
                    
                    // Re-check conditions when hotspot state changes
                    checkConditionsAndScheduleSync();
                }
                
                @Override
                public void onWifiCredentialsReceived(String ssid, String password, String authToken) {
                    // Not used
                }
                
                @Override
                public void onHotspotError(String errorMessage) {
                    // Not used
                }
            });
        }
        
        // Register for EventBus immediately so we don't miss battery events
        if (!EventBus.getDefault().isRegistered(this)) {
            EventBus.getDefault().register(this);
            Log.d(TAG, "📡 Registered for EventBus battery status updates (in constructor)");
        }
        
        // Set up upload progress callback
        cloudUploader.setCallback(new CloudGalleryUploader.UploadCallback() {
            @Override
            public void onProgress(String filename, int filesUploaded, int totalFiles) {
                int percent = totalFiles > 0 ? (filesUploaded * 100 / totalFiles) : 0;
                Log.i(TAG, "📤 Upload progress: [" + filesUploaded + "/" + totalFiles + "] " + percent + "% - Uploading: " + filename);
            }
            
            @Override
            public void onComplete(int filesUploaded, int filesFailed) {
                mSyncInProgress = false;
                Log.i(TAG, "");
                Log.i(TAG, "═══════════════════════════════════════════════════════════");
                Log.i(TAG, "✅✅✅ CLOUD GALLERY UPLOAD COMPLETE ✅✅✅");
                Log.i(TAG, "═══════════════════════════════════════════════════════════");
                Log.i(TAG, "📊 Upload Summary:");
                Log.i(TAG, "   ✅ Successfully uploaded: " + filesUploaded + " files");
                Log.i(TAG, "   ❌ Failed: " + filesFailed + " files");
                Log.i(TAG, "   📦 Total processed: " + (filesUploaded + filesFailed) + " files");
                if (filesUploaded > 0) {
                    Log.i(TAG, "   🎉 Success rate: " + (filesUploaded * 100 / (filesUploaded + filesFailed)) + "%");
                }
                Log.i(TAG, "═══════════════════════════════════════════════════════════");
                Log.i(TAG, "✅✅✅ UPLOAD FINISHED ✅✅✅");
                Log.i(TAG, "");
            }
            
            @Override
            public void onError(String filename, String error) {
                Log.e(TAG, "❌ Upload error for " + filename + ": " + error);
            }
        });
        
        Log.i(TAG, "🔄 BackgroundGallerySyncManager initialized");
    }
    
    /**
     * Start monitoring charging and WiFi state
     */
    public void startMonitoring() {
        Log.i(TAG, "🔄 startMonitoring() called. Current monitoring state: " + mIsMonitoring);
        if (mIsMonitoring) {
            Log.w(TAG, "⚠️ Already monitoring - skipping start");
            return;
        }
        
        Log.i(TAG, "🔄 Starting background sync monitoring");
        
        // EventBus already registered in constructor - no need to register again
        
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
        
        // Unregister from EventBus
        if (EventBus.getDefault().isRegistered(this)) {
            EventBus.getDefault().unregister(this);
            Log.d(TAG, "📡 Unregistered from EventBus battery status updates");
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
     * EventBus subscriber for battery status updates from StateManager
     * Called when glasses hardware battery status is received via Bluetooth from MCU
     */
    @Subscribe(threadMode = ThreadMode.MAIN)
    public void onBatteryStatusEvent(BatteryStatusEvent event) {
        Log.d(TAG, "🔋 Battery status updated: " + event.getBatteryLevel() + "% " + 
                  (event.isCharging() ? "(charging)" : "(not charging)"));
        // Trigger condition check when battery status changes
        checkConditionsAndScheduleSync();
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
        // Skip condition check if already uploading or sync in progress
        if (mSyncInProgress || mCloudUploader.isUploading()) {
            Log.d(TAG, "⏸️ Sync already in progress - skipping condition check");
            return;
        }
        
        // BLOCK cloud uploads during WiFi Direct sync (when hotspot is enabled)
        if (mHotspotEnabled) {
            Log.i(TAG, "🚫 WiFi Direct sync active (hotspot enabled) - blocking cloud uploads");
            
            // Cancel any pending sync
            if (mSyncDebounceRunnable != null) {
                Log.d(TAG, "❌ Cancelling pending cloud upload due to WiFi Direct sync");
                mHandler.removeCallbacks(mSyncDebounceRunnable);
                mSyncDebounceRunnable = null;
            }
            
            // Cancel any active upload
            if (mCloudUploader.isUploading()) {
                Log.i(TAG, "🛑 Cancelling active cloud upload due to WiFi Direct sync");
                mCloudUploader.cancelUpload();
                mSyncInProgress = false; // Reset sync state since we cancelled
            }
            
            return;
        }
        
        // Use GLASSES hardware battery status from StateManager (reported via Bluetooth from MCU)
        // boolean isCharging = mStateManager.isCharging(); // COMMENTED OUT - controlled by REQUIRE_CHARGING constant
        boolean isWifiConnected = mStateManager.isConnectedToWifi();
        boolean syncEnabled = mPrefs.getBoolean(PREF_ENABLE_BACKGROUND_SYNC, true);
        boolean wifiOnly = mPrefs.getBoolean(PREF_CLOUD_SYNC_WIFI_ONLY, true);
        // int minBattery = mPrefs.getInt(PREF_CLOUD_SYNC_MIN_BATTERY, 20); // COMMENTED OUT - controlled by REQUIRE_MIN_BATTERY constant
        // int currentBattery = mStateManager.getBatteryLevel(); // COMMENTED OUT - controlled by REQUIRE_MIN_BATTERY constant
        
        // Get battery status only if checks are enabled (for logging)
        boolean isCharging = REQUIRE_CHARGING ? mStateManager.isCharging() : false;
        int currentBattery = REQUIRE_MIN_BATTERY ? mStateManager.getBatteryLevel() : -1;
        int minBattery = REQUIRE_MIN_BATTERY ? mPrefs.getInt(PREF_CLOUD_SYNC_MIN_BATTERY, 20) : 0;
        
        Log.d(TAG, "📊 Condition check: charging=" + (REQUIRE_CHARGING ? isCharging : "DISABLED") + 
                  " (glasses), wifi=" + isWifiConnected + 
                  ", enabled=" + syncEnabled + 
                  ", glasses_battery=" + (REQUIRE_MIN_BATTERY ? (currentBattery + "% (min: " + minBattery + "%)") : "DISABLED"));
        
        // Check all conditions
        // All checks use glasses hardware status (reported via Bluetooth from MCU)
        boolean conditionsMet = syncEnabled &&
                              (!REQUIRE_CHARGING || isCharging) &&  // Glasses hardware must be charging (if enabled)
                              (!REQUIRE_MIN_BATTERY || (currentBattery >= minBattery || currentBattery == -1)) && // Glasses battery check (if enabled, -1 means unknown, allow sync)
                              (!wifiOnly || isWifiConnected);
        
        // Check if there are files to upload before scheduling
        if (conditionsMet) {
            mUploadQueue.buildQueue();
            int pendingCount = mUploadQueue.getTotalFiles();
            if (pendingCount > 0) {
                Log.d(TAG, "📋 Found " + pendingCount + " files to upload - scheduling sync");
                scheduleSync();
            } else {
                Log.d(TAG, "📋 No files to upload - skipping sync");
            }
        } else {
            // Conditions not met - cancel any pending sync
            if (mSyncDebounceRunnable != null) {
                Log.d(TAG, "❌ Conditions no longer met - cancelling pending sync");
                mHandler.removeCallbacks(mSyncDebounceRunnable);
                mSyncDebounceRunnable = null;
            }
            
            // Stop any active upload
            if (mCloudUploader.isUploading()) {
                Log.i(TAG, "⏸️ Conditions no longer met - cancelling active upload");
                mCloudUploader.cancelUpload();
                mSyncInProgress = false; // Reset sync state since we cancelled
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
        
        // BLOCK if hotspot is enabled (WiFi Direct sync active)
        if (mHotspotEnabled) {
            Log.i(TAG, "🚫 WiFi Direct sync active (hotspot enabled) - blocking cloud upload start");
            return;
        }
        
        // Double-check if already uploading (race condition protection)
        if (mSyncInProgress || mCloudUploader.isUploading()) {
            Log.d(TAG, "⏸️ Already uploading - skipping duplicate start");
            return;
        }
        
        // Get pending count from already-built queue (built in checkConditionsAndScheduleSync)
        // Note: startUpload() will rebuild the queue anyway for accuracy at upload time
        int pendingCount = mUploadQueue.getTotalFiles();
        if (pendingCount == 0) {
            Log.i(TAG, "📋 No files to upload - sync complete");
            mSyncInProgress = false;
            return;
        }
        
        // Mark sync as in progress
        mSyncInProgress = true;
        
        // Start the upload
        Log.i(TAG, "🚀 Starting cloud gallery upload - " + pendingCount + " files queued");
        Log.i(TAG, "▶️ Calling mCloudUploader.startUpload()...");
        Log.i(TAG, "   mCloudUploader instance: " + mCloudUploader.getClass().getName());
        Log.i(TAG, "   mCloudUploader.isUploading(): " + mCloudUploader.isUploading());
        mCloudUploader.startUpload();
        Log.i(TAG, "▶️ mCloudUploader.startUpload() returned");
        
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
