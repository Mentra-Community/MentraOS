package com.augmentos.otaupdater;

import com.augmentos.otaupdater.helper.Constants;
import com.augmentos.otaupdater.helper.OtaHelper;

import android.os.Bundle;
import androidx.activity.EdgeToEdge;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import com.augmentos.otaupdater.worker.OtaCheckWorker;

import java.util.concurrent.TimeUnit;

public class MainActivity extends AppCompatActivity {
    private static final String TAG = MainActivity.TAG;
    private OtaHelper otaHelper;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        EdgeToEdge.enable(this);
        setContentView(R.layout.activity_main);
        ViewCompat.setOnApplyWindowInsetsListener(findViewById(R.id.main), (v, insets) -> {
            Insets systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars());
            v.setPadding(systemBars.left, systemBars.top, systemBars.right, systemBars.bottom);
            return insets;
        });

        // Initialize OtaHelper
        otaHelper = new OtaHelper();

        // Set up periodic work request
        setupPeriodicOtaCheck();

        // Register for WiFi connectivity changes
        otaHelper.registerNetworkCallback(this);
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        otaHelper.unregisterNetworkCallback();
    }

    private void setupPeriodicOtaCheck() {
        Constraints constraints = new Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build();

        PeriodicWorkRequest otaWork = new PeriodicWorkRequest.Builder(OtaCheckWorker.class, 15, TimeUnit.MINUTES)
            .setConstraints(constraints)
            .build();

        WorkManager.getInstance(this).enqueueUniquePeriodicWork(
            Constants.WORK_NAME_OTA_CHECK, ExistingPeriodicWorkPolicy.KEEP, otaWork);

        // TODO Remove on Release TEMP: Enqueue a one-time OTA check to test immediately
        androidx.work.OneTimeWorkRequest testOtaWork = new androidx.work.OneTimeWorkRequest.Builder(OtaCheckWorker.class).build();
        WorkManager.getInstance(this).enqueue(testOtaWork);
    }
}
