package com.mentra.asg_client;

import android.app.Application;
import android.util.Log;

import com.mentra.asg_client.di.AppModule;
import com.mentra.asg_client.reporting.core.ReportManager;
import com.mentra.asg_client.di.ReportingModule;

/**
 * Application class for ASG Client
 * Handles app-wide initialization following SOLID principles
 */
public class AsgClientApplication extends Application {

    private static final String TAG = "AsgClientApplication";
    private static AsgClientApplication instance;

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;

        AppModule.initialize(this);
        ReportingModule.initialize(this);

        SysControl.setI2SAudioPlayReceiverPackage(this, getPackageName());

        // Get and log system OTA version (MTK firmware version)
        String systemOtaVersion = SysControl.getSystemCurrentVersion(this);
        Log.i(TAG, "📱 System OTA Version (MTK): " + systemOtaVersion);

        Log.i(TAG, "ASG Client Application initialized");
    }


    /**
     * Get application instance
     */
    public static AsgClientApplication getInstance() {
        return instance;
    }

    /**
     * Get ReportManager instance
     */
    public ReportManager getReportManager() {
        return ReportManager.getInstance(this);
    }
} 
