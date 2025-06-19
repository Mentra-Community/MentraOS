package com.augmentos.augmentos_core;

import android.app.Notification;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import android.text.TextUtils;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.preference.PreferenceManager;

import com.augmentos.augmentos_core.events.NewScreenTextEvent;

import org.greenrobot.eventbus.EventBus;

import java.util.Arrays;
import java.util.List;

public class MyNotificationListeners extends NotificationListenerService {

    private static final String TAG = "NotificationListener";

    private final List<String> packageBlacklist = Arrays.asList(
            "com.android.systemui",
            "com.samsung.android.app.smartcapture",
            "com.sec.android.app.camera",
            "com.sec.android.gallery3d",
            "com.github.welldomax.tunnelshare"
    );

    private final List<String> categoryBlacklist = Arrays.asList(
            Notification.CATEGORY_REMINDER,
            Notification.CATEGORY_ALARM,
            Notification.CATEGORY_EVENT,
            Notification.CATEGORY_SERVICE
    );

    @Override
    public void onCreate() {
        super.onCreate();
        Log.d(TAG, "Service Created");
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Log.d(TAG, "Service Started");
        return super.onStartCommand(intent, flags, startId);
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        Log.d(TAG, "Service Destroyed");
    }

    @Override
    public boolean onUnbind(Intent intent) {
        // Perform cleanup here
        stopSelf(); // This will stop the NotificationListenerService
        return super.onUnbind(intent);
    }

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        if (!shouldListenForNotifications()) return;

        String packageName = sbn.getPackageName();

        Log.d(TAG, "Notification Posted: " + sbn.getPackageName());

        // Filter by package blacklist
        if (packageBlacklist.contains(packageName)) {
            Log.d(TAG, "Notification from " + packageName + " ignored");
            return;
        }

        Notification notification = sbn.getNotification();

        // Filter by category
        String category = notification.category;
        if (category != null && categoryBlacklist.contains(category)) {
            Log.d(TAG, "Notification with category " + category + " ignored");
            return;
        }

        String appName = getAppName(packageName);
        String title = "";
        String text = "";

        Bundle extras = notification.extras;
        if (extras != null) {
            // Extract title and text from notification extras
            title = extras.getString(Notification.EXTRA_TITLE);
            CharSequence textCharSequence = extras.getCharSequence(Notification.EXTRA_TEXT);
            if (textCharSequence != null) {
                text = textCharSequence.toString();
            }

            // Extract text lines from InboxStyle
            CharSequence[] textLines = extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES);
            if (textLines != null && textLines.length > 0) {
                StringBuilder inboxText = new StringBuilder();
                for (CharSequence line : textLines) {
                    if (inboxText.length() > 0) {
                        inboxText.append("\n");
                    }
                    inboxText.append(line);
                }
                text = inboxText.toString();
            }

            // Extract messages from MessagingStyle
            NotificationCompat.MessagingStyle messagingStyle = NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(notification);
            if (messagingStyle != null) {
                StringBuilder messagingText = new StringBuilder();
                for (NotificationCompat.MessagingStyle.Message message : messagingStyle.getMessages()) {
                    if (message.getText() != null) {
                        if (messagingText.length() > 0) {
                            messagingText.append("\n");
                        }
                        messagingText.append(message.getText().toString());
                    }
                }
                text = messagingText.toString();
            }

            // Handle BigTextStyle
            CharSequence bigText = extras.getCharSequence(Notification.EXTRA_BIG_TEXT);
            if (bigText != null) {
                text = bigText.toString();
            }
        }

        if(TextUtils.isEmpty(title)) {
            EventBus.getDefault().post(new NewScreenTextEvent(appName, "new notification"));
        }
        else{
            title = appName + " | " + title;

            EventBus.getDefault().post(new NewScreenTextEvent(title, text));
        }
    }

    @Override
    public void onNotificationRemoved(StatusBarNotification sbn) {
        // This method is called when a notification is removed
        Log.d(TAG, "Notification Removed: " + sbn.getPackageName());
    }

    @Override
    public void onListenerConnected() {
        super.onListenerConnected();
        Log.d(TAG, "Listener Connected");
    }

    @Override
    public void onListenerDisconnected() {
        super.onListenerDisconnected();
        Log.d(TAG, "Listener Disconnected");
    }

    private String getAppName(String packageName) {
        PackageManager packageManager = getPackageManager();
        try {
            ApplicationInfo appInfo = packageManager.getApplicationInfo(packageName, 0);
            return (String) packageManager.getApplicationLabel(appInfo);
        } catch (PackageManager.NameNotFoundException e) {
            e.printStackTrace();
            return packageName;
        }
    }

    public boolean shouldListenForNotifications() {
        return PreferenceManager.getDefaultSharedPreferences(getApplicationContext()).getBoolean("should_display_notifications", false);
    }
}