package com.mentra.asg_client;

import android.app.Application;
import android.util.Log;
import com.mentra.asg_client.di.ReportingModule;
import com.mentra.asg_client.reporting.CrashHandler;
import com.mentra.asg_client.reporting.core.ReportManager;
import com.mentra.asg_client.service.system.core.SystemControllerFactory;
import dagger.hilt.android.HiltAndroidApp;

/** Application class for ASG Client. */
@HiltAndroidApp
public class AsgClientApplication extends Application {

    private static final String TAG = "AsgClientApplication";
    private static AsgClientApplication instance;

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;

        CrashHandler.install();
        ReportingModule.initialize(this);

        SystemControllerFactory.get(this).setI2SAudioPlayReceiverPackage(getPackageName());

        String systemOtaVersion = SystemControllerFactory.get(this).getSystemOtaVersion();
        Log.i(TAG, "System OTA Version (MTK): " + systemOtaVersion);

        Log.i(TAG, "ASG Client Application initialized");
    }

    public static AsgClientApplication getInstance() {
        return instance;
    }

    public ReportManager getReportManager() {
        return ReportManager.getInstance(this);
    }
}
