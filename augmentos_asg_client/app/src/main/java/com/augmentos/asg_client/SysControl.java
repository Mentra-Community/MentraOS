package com.augmentos.asg_client;

import android.content.Context;
import android.content.Intent;
import android.provider.Settings;
import android.util.Log;
import android.view.KeyEvent;

public class SysControl {
    private static final String TAG = "SysControl";
    private static boolean mbSleep = false;
    
    public static void clickKeyEvent(Context context, int keyCode) {
        Intent nn = new Intent();
        nn.putExtra("cmd", "keyevent");
        nn.putExtra("keycode", keyCode);
        sendBroadcast(context, nn);
    }
    
    public static void clickOK(Context context) {
        clickKeyEvent(context, KeyEvent.KEYCODE_ENTER);
    }
    
    public static void volumeUp(Context context, boolean bUp) {
        clickKeyEvent(context, bUp ? KeyEvent.KEYCODE_VOLUME_UP : KeyEvent.KEYCODE_VOLUME_DOWN);
    }
    
    public static void brightUp(Context context, boolean bUp) {
        try {
            int value = Settings.System.getInt(context.getContentResolver(), Settings.System.SCREEN_BRIGHTNESS);
            value += bUp ? 25 : -25;
            setBrightValue(context, value);
        } catch (Settings.SettingNotFoundException e) {
            // Fallback to default brightness adjustment
            setBrightValue(context, bUp ? 200 : 100);
        }
    }

    public static void wakeupOrSleep(Context context) {
        if(mbSleep)
            clickKeyEvent(context, KeyEvent.KEYCODE_WAKEUP);
        else
            clickKeyEvent(context, KeyEvent.KEYCODE_SLEEP);
        mbSleep = !mbSleep;
    }
    
    // NEW METHODS - Power Control
    public static void reboot(Context context) {
        Intent nn = new Intent();
        nn.putExtra("cmd", "reboot");
        sendBroadcast(context, nn);
    }
    
    // NEW METHODS - Key Events & Interaction
    public static void clickPosition(Context context, int x, int y) {
        Intent nn = new Intent();
        nn.putExtra("cmd", "clickposition");
        nn.putExtra("x", x);
        nn.putExtra("y", y);
        sendBroadcast(context, nn);
    }
    
    public static void swipe(Context context, int x1, int y1, int x2, int y2) {
        Intent nn = new Intent();
        nn.putExtra("cmd", "swipe");
        nn.putExtra("x1", x1);
        nn.putExtra("y1", y1);
        nn.putExtra("x2", x2);
        nn.putExtra("y2", y2);
        sendBroadcast(context, nn);
    }
    
    public static void swipeLeft(Context context) {
        Intent nn = new Intent();
        nn.putExtra("cmd", "swipeleft");
        sendBroadcast(context, nn);
    }
    
    public static void swipeRight(Context context) {
        Intent nn = new Intent();
        nn.putExtra("cmd", "swiperight");
        sendBroadcast(context, nn);
    }
    
    public static void swipeUp(Context context) {
        Intent nn = new Intent();
        nn.putExtra("cmd", "swipeup");
        sendBroadcast(context, nn);
    }
    
    public static void swipeDown(Context context) {
        Intent nn = new Intent();
        nn.putExtra("cmd", "swipedown");
        sendBroadcast(context, nn);
    }
    
    public static void inputText(Context context, String text) {
        Intent nn = new Intent();
        nn.putExtra("cmd", "inputtext");
        nn.putExtra("text", text);
        sendBroadcast(context, nn);
    }

    public static void setBrightValue(Context context, int bright) {
        if(bright < 25)
            bright = 25;
        if(bright > 250)
            bright = 250;
        Intent nn = new Intent();
        nn.putExtra("cmd", "brightness");
        nn.putExtra("value", bright);
        sendBroadcast(context, nn);
    }
    
    public static void setSystemTime(Context context, long timeMill) {
        Intent nn = new Intent();
        nn.putExtra("cmd", "settime");
        nn.putExtra("timemills", timeMill);
        sendBroadcast(context, nn);
    }
    
    public static void stopApp(Context context, String pkname) {
        Intent nn = new Intent();
        nn.putExtra("cmd", "forceStop");
        nn.putExtra("pkname", pkname);
        sendBroadcast(context, nn);
    }

    public static void installApk(Context context, String filePath) {
        Intent nn = new Intent();
        nn.putExtra("cmd", "install");
        nn.putExtra("pkpath", filePath);
        nn.putExtra("recv_pkname", context.getPackageName());
        nn.putExtra("startapp", true);
        sendBroadcast(context, nn);
    }
    
    public static void wakeUp(Context context) {
        Intent nn = new Intent();
        nn.putExtra("cmd", "wakeup");
        sendBroadcast(context, nn);
    }
    
    public static void sleep(Context context) {
        Intent nn = new Intent();
        nn.putExtra("cmd", "sleep");
        sendBroadcast(context, nn);
    }
    
    public static void openHotspot(Context context, String ssid, String pwd) {
        Intent nn = new Intent();
        nn.putExtra("cmd", "ap_start");
        nn.putExtra("enable", true);
        if(ssid != null && ssid.length() > 0)
            nn.putExtra("ssid", ssid);
        if(pwd != null && pwd.length() >= 8)
            nn.putExtra("pwd", pwd);
        sendBroadcast(context, nn);
    }
    
    public static void closeHotspot(Context context) {
        Intent nn = new Intent();
        nn.putExtra("cmd", "ap_start");
        nn.putExtra("enable", false);
        sendBroadcast(context, nn);
    }
    
    // NEW METHODS - OTA/System Updates
    public static void triggerOTA(Context context) {
        Intent nn = new Intent("com.xy.updateota");
        nn.setPackage("com.android.systemui");
        context.sendBroadcast(nn);
    }
    
    // NEW METHODS - Advanced Hotspot Control
    public static void openHotspotAlt(Context context) {
        Intent nn = new Intent();
        nn.putExtra("cmd", "openAp");
        sendBroadcast(context, nn);
    }
    
    public static void closeHotspotAlt(Context context) {
        Intent nn = new Intent();
        nn.putExtra("cmd", "closeAp");
        sendBroadcast(context, nn);
    }
    
    public static void enableAutoHotspot(Context context, boolean enable) {
        Intent nn = new Intent();
        nn.putExtra("cmd", "autohotspot");
        nn.putExtra("enable", enable);
        sendBroadcast(context, nn);
    }
    
    // NEW METHODS - Package Management (EXPERIMENTAL)
    public static void enablePackage(Context context, String packageName) {
        Intent nn = new Intent();
        nn.putExtra("cmd", "enable");
        nn.putExtra("pkname", packageName);
        sendBroadcast(context, nn);
    }
    
    public static void disablePackage(Context context, String packageName) {
        Intent nn = new Intent();
        nn.putExtra("cmd", "disable");
        nn.putExtra("pkname", packageName);
        sendBroadcast(context, nn);
    }
    
    public static void uninstallPackage(Context context, String packageName) {
        Intent nn = new Intent();
        nn.putExtra("cmd", "uninstall");
        nn.putExtra("pkname", packageName);
        sendBroadcast(context, nn);
    }
    
    // BREAKTHROUGH METHOD - ADB Command Injection via && prefix
    public static void injectAdbCommand(Context context, String shellCommand) {
        Log.d(TAG, "=== injectAdbCommand START ===");
        Log.d(TAG, "Context: " + context);
        Log.d(TAG, "Shell command: " + shellCommand);
        
        Intent nn = new Intent();
        nn.putExtra("cmd", "adb");
        String fullValue = "adb && " + shellCommand;
        nn.putExtra("value", fullValue);
        
        Log.d(TAG, "Created intent with cmd='adb' and value='" + fullValue + "'");
        
        try {
            sendBroadcast(context, nn);
            Log.d(TAG, "Broadcast sent successfully");
        } catch (Exception e) {
            Log.e(TAG, "Error sending broadcast: " + e.getMessage(), e);
        }
        
        Log.d(TAG, "=== injectAdbCommand END ===");
    }
    
    // Convenience methods using the ADB injection
    public static void disablePackageViaAdb(Context context, String packageName) {
        injectAdbCommand(context, "pm disable-user " + packageName);
    }
    
    public static void enablePackageViaAdb(Context context, String packageName) {
        injectAdbCommand(context, "pm enable " + packageName);
    }
    
    public static void uninstallPackageViaAdb(Context context, String packageName) {
        injectAdbCommand(context, "pm uninstall " + packageName);
    }
    
    private static void sendBroadcast(Context context, Intent nn) {
        Log.d(TAG, "=== sendBroadcast START ===");
        nn.setAction("com.xy.xsetting.action");
        nn.setPackage("com.android.systemui");
        
        // Try explicit component targeting
        nn.setComponent(new android.content.ComponentName("com.android.systemui", "com.android.systemui.CTReceiver"));
        
        // Use exact same flags as working ADB command (0x400000)
        nn.setFlags(0x400000);
        
        Log.d(TAG, "Intent action: " + nn.getAction());
        Log.d(TAG, "Intent package: " + nn.getPackage());
        Log.d(TAG, "Intent flags: " + Integer.toHexString(nn.getFlags()));
        Log.d(TAG, "Intent extras: " + nn.getExtras());
        
        try {
            context.sendBroadcast(nn);
            Log.d(TAG, "context.sendBroadcast() completed");
        } catch (Exception e) {
            Log.e(TAG, "Exception in sendBroadcast: " + e.getMessage(), e);
        }
        
        Log.d(TAG, "=== sendBroadcast END ===");
    }
}