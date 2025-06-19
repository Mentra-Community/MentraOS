package com.mentra.mentraoslib;

import static com.mentra.mentraoslib.AugmentOSGlobalConstants.AUGMENTOS_NOTIFICATION_CHANNEL_ID;
import static com.mentra.mentraoslib.AugmentOSGlobalConstants.AUGMENTOS_NOTIFICATION_CHANNEL_NAME;
import static com.mentra.mentraoslib.AugmentOSGlobalConstants.AUGMENTOS_NOTIFICATION_DESCRIPTION;
import static com.mentra.mentraoslib.AugmentOSGlobalConstants.AUGMENTOS_NOTIFICATION_ID;
import static com.mentra.mentraoslib.AugmentOSGlobalConstants.AUGMENTOS_NOTIFICATION_TITLE;
import static com.mentra.mentraoslib.AugmentOSGlobalConstants.AugmentOSManagerPackageName;

import android.app.Notification;
import android.app.PendingIntent;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Binder;
import android.os.Bundle;
import android.os.IBinder;
import android.preference.PreferenceManager;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.lifecycle.LifecycleService;

import com.mentra.mentraoslib.events.KillTpaEvent;

import org.greenrobot.eventbus.Subscribe;

import java.util.Objects;
import java.util.UUID;

//a service provided for third party apps to extend, that make it easier to create a service in Android that will continually run in the background
public abstract class SmartGlassesAndroidService extends LifecycleService {
    // Service Binder given to clients
    private final IBinder binder = new LocalBinder();
    public static final String TAG = "SmartGlassesAndroidService_AugmentOS";
    public static final String INTENT_ACTION = "AUGMENTOS_INTENT";
    public static final String TPA_ACTION = "tpaAction";
    public static final String ACTION_START_FOREGROUND_SERVICE = "AugmentOSLIB_ACTION_START_FOREGROUND_SERVICE";
    public static final String ACTION_STOP_FOREGROUND_SERVICE = "AugmentOSLIB_ACTION_STOP_FOREGROUND_SERVICE";
    public FocusStates focusState;

    public SmartGlassesAndroidService(){
        this.focusState = FocusStates.OUT_FOCUS;
    }


    public static Notification buildSharedForegroundNotification(Context context) {
        String title = AUGMENTOS_NOTIFICATION_TITLE;
        String description = AUGMENTOS_NOTIFICATION_DESCRIPTION;

        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    AUGMENTOS_NOTIFICATION_CHANNEL_ID,
                    AUGMENTOS_NOTIFICATION_CHANNEL_NAME,
                    NotificationManager.IMPORTANCE_HIGH
            );
            channel.setDescription(description);
            manager.createNotificationChannel(channel);
        }

        Intent launchIntent = context.getPackageManager().getLaunchIntentForPackage(AugmentOSManagerPackageName);

        PendingIntent pendingIntent = null;

        if (launchIntent != null) {
            // Optionally, set flags so the existing Activity in the stack is used, rather than creating a new one.
            // This helps preserve the current Activity state if the user is already in the app.
            launchIntent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);

            // Use FLAG_IMMUTABLE if you target Android 12+ and don't need the PendingIntent to be mutable
            pendingIntent = PendingIntent.getActivity(
                    context,
                    0,
                    launchIntent,
                    PendingIntent.FLAG_IMMUTABLE
            );
        }

        return new NotificationCompat.Builder(context, AUGMENTOS_NOTIFICATION_CHANNEL_ID)
                .setContentTitle(title)
                .setContentText(description)
                .setSmallIcon(android.R.drawable.sym_def_app_icon)
                .setOngoing(true)
                .setContentIntent(pendingIntent)
                .build();
    }


    public class LocalBinder extends Binder {
        public SmartGlassesAndroidService getService() {
            // Return this instance of LocalService so clients can call public methods
            return SmartGlassesAndroidService.this;
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        super.onBind(intent);
        return binder;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        super.onStartCommand(intent, flags, startId);
        if (intent != null) {
            String action = intent.getAction();
            Bundle extras = intent.getExtras();
           
            //True when service is started from AugmentOS
            if(Objects.equals(action, INTENT_ACTION) && extras != null){
                action = (String) extras.get(TPA_ACTION);
            }

            switch (action) {
                case ACTION_START_FOREGROUND_SERVICE:
                    // start the service in the foreground
                    Log.d("TEST", "starting foreground");
                    //startForeground(NOTIFICATION_ID, updateNotification());
                    startForeground(AUGMENTOS_NOTIFICATION_ID, buildSharedForegroundNotification(this));

                    setup();
                    break;
                case ACTION_STOP_FOREGROUND_SERVICE:
                    stopForeground(true);
                    stopSelf();
                    break;
            }
        }
        return Service.START_STICKY;
    }

    @Subscribe
    public void onKillTpaEvent(KillTpaEvent receivedEvent){
        //if(receivedEvent.uuid == this.appUUID) //TODO: Figure out implementation here...
        Log.d(TAG, "TPA KILLING SELF");
        if(true)
        {
            Log.d(TAG, "TPA KILLING SELF received");
            stopForeground(true);
            Log.d(TAG, "Foreground stopped");
            stopSelf();
            Log.d(TAG, "Self stopped, service should end.");
        }
    }

    protected String getUserId() {
        SharedPreferences prefs = PreferenceManager.getDefaultSharedPreferences(this);
        String userId = prefs.getString("user_id", "");

        if (userId.isEmpty()) {
            // Generate a random UUID string if no userId exists
            userId = UUID.randomUUID().toString();

            // Save the new userId to SharedPreferences
            prefs.edit()
                    .putString("user_id", userId)
                    .apply();
        }

        return userId;
    }

    @Override
    public void onCreate(){
        super.onCreate();
        AugmentOSLibBus.getInstance().register(this);
    }
    
    @Override
    public void onDestroy(){
        Log.d(TAG, "running onDestroy");
        AugmentOSLibBus.getInstance().unregister(this);
        super.onDestroy();
        Log.d(TAG, "ran onDestroy");
    }

    public abstract void setup();
}
