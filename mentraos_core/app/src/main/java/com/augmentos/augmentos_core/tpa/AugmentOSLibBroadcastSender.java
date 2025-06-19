package com.augmentos.augmentos_core.tpa;

import static com.mentra.mentraoslib.AugmentOSGlobalConstants.EVENT_BUNDLE;
import static com.mentra.mentraoslib.AugmentOSGlobalConstants.EVENT_ID;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import com.mentra.mentraoslib.AugmentOSCommand;
import com.mentra.mentraoslib.AugmentOSGlobalConstants;
import com.mentra.mentraoslib.SmartGlassesAndroidService;
import com.mentra.mentraoslib.ThirdPartyEdgeApp;
import com.mentra.mentraoslib.ThirdPartyAppType;
import com.mentra.mentraoslib.events.CommandTriggeredEvent;
import com.mentra.mentraoslib.events.KillTpaEvent;

import org.greenrobot.eventbus.EventBus;

import java.io.IOException;
import java.io.Serializable;

public class AugmentOSLibBroadcastSender {
    private String TAG = "WearableAi_AugmentOSLibBroadcastSEnder";
    private String intentPkg;
    Context context;

    public AugmentOSLibBroadcastSender(Context context) {
        this.context = context;
        this.intentPkg = AugmentOSGlobalConstants.TO_TPA_FILTER;
    }

    public void sendEventToAllTPAs(String eventId, Serializable eventBundle) {
        sendEventToTPAs(eventId, eventBundle, null);
    }

    public void sendEventToTPAs(String eventId, Serializable eventBundle, String tpaPackageName) {
        //If we're triggering a command, make sure the command's respective service is running
        if(eventId == CommandTriggeredEvent.eventId){
            AugmentOSCommand cmd = ((CommandTriggeredEvent)eventBundle).command;
            startSgmCommandService(cmd);
            //delay a short time so the service can start before we send it the data
            try {
                Thread.sleep(450);
            } catch (InterruptedException e){
                e.printStackTrace();
                Log.d(TAG, "Interrupted while waiting for TPA service to start.");
            }
        }

        //setup intent to send
        Intent intent = new Intent();
        intent.setAction(intentPkg);
        if (tpaPackageName != null) {
            intent.setPackage(tpaPackageName);
        }
        intent.setFlags(Intent.FLAG_INCLUDE_STOPPED_PACKAGES);

        //load in and send data
        intent.putExtra(EVENT_ID, eventId);
        intent.putExtra(EVENT_BUNDLE, eventBundle);
        context.sendBroadcast(intent);
    }

    public boolean startThirdPartyApp(ThirdPartyEdgeApp tpa){
        if(tpa.packageName == "" || tpa.serviceName == ""){
            return false;
        }

        Intent i = new Intent();
        i.setAction(SmartGlassesAndroidService.INTENT_ACTION);
        i.putExtra(SmartGlassesAndroidService.TPA_ACTION, SmartGlassesAndroidService.ACTION_START_FOREGROUND_SERVICE);
        i.setComponent(new ComponentName(tpa.packageName, tpa.serviceName));
        ComponentName c = context.startForegroundService(i);

        return true;
    }

    public void killThirdPartyApp(ThirdPartyEdgeApp tpa){
        Log.d(TAG, "Attempting to kill third-party app: " + tpa.packageName);
        if (tpa.appType == ThirdPartyAppType.CORE_SYSTEM) {
            Log.d(TAG, "Cannot kill a core system app: " + tpa.packageName);
            return; // Initially forgetting to add this return statement has cost me hours of my fleeting life
        };

        // KINDLY ask the TPA to kill itself
        EventBus.getDefault().post(new KillTpaEvent(tpa));

        // Just in case it did not, KILL IT WITH FIRE
        Intent intent = new Intent();
        intent.setComponent(new ComponentName(tpa.packageName, tpa.serviceName));
        context.stopService(intent);

        // DEPLOY THE LOW ORBITAL ION CANNON IN EVENT OF NON-COMPLIANCE
        try {
            String command = "am force-stop " + tpa.packageName;
            Process process = Runtime.getRuntime().exec(command);
            process.waitFor();
        } catch (IOException | InterruptedException e) {
            // Log the error, if needed, but let it fail silently otherwise
            e.printStackTrace();
        }

        //blank the screen
//        EventBus.getDefault().post(new ReferenceCardSimpleViewRequestEvent("AugmentOS stopped app:", tpa.appName, 6));
        //EventBus.getDefault().post(new HomeScreenEvent());
    }

    public boolean isThirdPartyAppRunning(ThirdPartyEdgeApp tpa) {
// TODO: Cannot be implemented this way w/o being a system level app
        //        if (tpa.packageName.isEmpty() || tpa.serviceName.isEmpty()) {
//            return false; // Invalid TPA details
//        }
//
//        ActivityManager activityManager = (ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
//        if (activityManager == null) {
//            return false; // If ActivityManager is not available
//        }
//
//        // Iterate through the list of running services
//        for (ActivityManager.RunningServiceInfo service : activityManager.getRunningServices(Integer.MAX_VALUE)) {
//            if (service.service.getPackageName().equals(tpa.packageName) &&
//                    service.service.getClassName().equals(tpa.serviceName)) {
//                return true; // Found the running service
//            }
//        }
//
//        return false; // Service not running
        return false;
    }

    //Starts a AugmentOSCommand's service (if not already running)
    public void startSgmCommandService(AugmentOSCommand augmentosCommand){
        //tpaPackageName = "com.google.mlkit.samples.nl.translate";
        //tpaServiceName = ".java.TranslationService";


//        Log.d(TAG, "Starting command package: " + augmentosCommand.packageName);
//        Log.d(TAG, "Starting command service: " + augmentosCommand.serviceName);
//
//        if(augmentosCommand.getPackageName() == "" || augmentosCommand.getServiceName() == ""){
//            return;
//        }
//
//        Intent i = new Intent();
//        i.setAction(SmartGlassesAndroidService.INTENT_ACTION);
//        i.putExtra(SmartGlassesAndroidService.TPA_ACTION, SmartGlassesAndroidService.ACTION_START_FOREGROUND_SERVICE);
//        i.setComponent(new ComponentName(augmentosCommand.packageName, augmentosCommand.serviceName));
//        ComponentName c = context.startForegroundService(i);
    }
}
