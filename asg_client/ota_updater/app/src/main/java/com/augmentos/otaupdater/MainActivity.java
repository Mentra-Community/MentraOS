package com.mentra.otaupdater;

import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.widget.TextView;
import androidx.appcompat.app.AppCompatActivity;
import com.mentra.otaupdater.helper.Constants;
import org.greenrobot.eventbus.EventBus;
import org.greenrobot.eventbus.Subscribe;
import org.greenrobot.eventbus.ThreadMode;
import com.mentra.otaupdater.events.DownloadProgressEvent;
import com.mentra.otaupdater.events.InstallationProgressEvent;

/**
 * Thin UI layer for OTA Updater
 * All business logic is handled by OtaUpdaterService
 */
public class MainActivity extends AppCompatActivity {
    private static final String TAG = Constants.TAG;
    private TextView statusText;
    private TextView progressText;
    
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        
        Log.d(TAG, "MainActivity onCreate");
        
        // Initialize UI
        statusText = findViewById(R.id.statusText);
        progressText = findViewById(R.id.progressText);
        
        // Start the service if not already running
        startOtaUpdaterService();
        
        // Register for UI updates
        EventBus.getDefault().register(this);
        
        // Update initial UI
        updateStatus("OTA Updater Active");
    }
    
    @Override
    protected void onDestroy() {
        super.onDestroy();
        // Unregister from EventBus
        if (EventBus.getDefault().isRegistered(this)) {
            EventBus.getDefault().unregister(this);
        }
    }
    
    private void startOtaUpdaterService() {
        Log.d(TAG, "Starting OTA Updater Service");
        Intent serviceIntent = new Intent(this, OtaUpdaterService.class);
        
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(serviceIntent);
        } else {
            startService(serviceIntent);
        }
    }
    
    private void updateStatus(String status) {
        runOnUiThread(() -> {
            if (statusText != null) {
                statusText.setText(status);
            }
        });
    }
    
    private void updateProgress(String progress) {
        runOnUiThread(() -> {
            if (progressText != null) {
                progressText.setText(progress);
            }
        });
    }
    
    // EventBus handlers for UI updates
    @Subscribe(threadMode = ThreadMode.MAIN)
    public void onDownloadProgress(DownloadProgressEvent event) {
        switch (event.getStatus()) {
            case STARTED:
                updateStatus("Downloading update...");
                updateProgress("0%");
                break;
            case PROGRESS:
                int percent = (int) ((event.getBytesDownloaded() * 100) / event.getTotalBytes());
                updateProgress(percent + "%");
                break;
            case FINISHED:
                updateStatus("Download complete");
                updateProgress("100%");
                break;
            case FAILED:
                updateStatus("Download failed");
                updateProgress(event.getErrorMessage());
                break;
        }
    }
    
    @Subscribe(threadMode = ThreadMode.MAIN)
    public void onInstallationProgress(InstallationProgressEvent event) {
        switch (event.getStatus()) {
            case STARTED:
                updateStatus("Installing update...");
                updateProgress("");
                break;
            case FINISHED:
                updateStatus("Installation complete");
                updateProgress("Success");
                break;
            case FAILED:
                updateStatus("Installation failed");
                updateProgress(event.getErrorMessage());
                break;
        }
    }
    
    // Manual update check button handler (if needed)
    public void onCheckUpdateClicked() {
        Intent intent = new Intent(this, OtaUpdaterService.class);
        intent.setAction("CHECK_UPDATES");
        
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent);
        } else {
            startService(intent);
        }
        
        updateStatus("Checking for updates...");
    }
}