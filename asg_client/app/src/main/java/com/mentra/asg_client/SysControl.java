package com.mentra.asg_client;

import android.content.Context;
import android.content.Intent;
import android.provider.Settings;
import android.util.Log;
import android.view.KeyEvent;
import com.mentra.asg_client.io.hardware.interfaces.IHardwareManager;
import com.mentra.asg_client.io.hardware.core.HardwareManagerFactory;
import com.mentra.asg_client.service.utils.SysProp;

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
    
    // WiFi Control Methods
    public static void enableWifi(Context context) {
        Intent nn = new Intent("com.xy.xsetting.action");
        nn.setPackage("com.android.systemui");
        nn.putExtra("cmd", "setwifi");
        nn.putExtra("enable", true);
        context.sendBroadcast(nn);
        
        Log.d(TAG, "Sent WiFi enable broadcast");
    }
    
    public static void disableWifi(Context context) {
        Intent nn = new Intent("com.xy.xsetting.action");
        nn.setPackage("com.android.systemui");
        nn.putExtra("cmd", "setwifi");
        nn.putExtra("enable", false);
        context.sendBroadcast(nn);
        
        Log.d(TAG, "Sent WiFi disable broadcast");
    }
    
    public static void connectToWifi(Context context, String ssid, String password) {
        if (ssid == null || ssid.isEmpty()) {
            Log.e(TAG, "Cannot connect to WiFi with empty SSID");
            return;
        }
        
        Log.d(TAG, "🔧 Attempting WiFi connection to: " + ssid);
        
        // Use the exact same pattern that works for scan_wifi
        Intent nn = new Intent("com.xy.xsetting.action");
        nn.setPackage("com.android.systemui");
        nn.putExtra("cmd", "connectwifi");
        nn.putExtra("ssid", ssid);
        nn.putExtra("pwd", password);
        context.sendBroadcast(nn);
        
        Log.d(TAG, "✅ Sent WiFi connect broadcast for SSID: " + ssid);
    }

    public static void disconnectFromWifi(Context context) {
        Log.d(TAG, "📶 Disconnecting from WiFi via SysControl...");
        Intent nn = new Intent("com.xy.xsetting.action");
        nn.setPackage("com.android.systemui");
        nn.putExtra("cmd", "disconnectwifi");
        context.sendBroadcast(nn);
    }

    public static void scanWifi(Context context) {
        // Use the exact same pattern that works
        Intent nn = new Intent("com.xy.xsetting.action");
        nn.setPackage("com.android.systemui");
        nn.putExtra("cmd", "scan_wifi");
        context.sendBroadcast(nn);
        
        Log.d(TAG, "Sent WiFi scan broadcast");
    }
    
    // NEW METHODS - OTA/System Updates
    public static void triggerOTA(Context context) {
        Intent nn = new Intent("com.xy.updateota");
        nn.setPackage("com.android.systemui");
        context.sendBroadcast(nn);
    }
    
    /**
     * Install MTK OTA firmware update
     * Sends a broadcast to the system to install MTK firmware from a zip file.
     * The system will handle extraction and installation automatically.
     * 
     * @param context Application context
     * @param otaPath Path to the MTK firmware zip file (e.g., "/sdcard/update.zip")
     */
    public static void installOTA(Context context, String otaPath) {
        if (otaPath == null || otaPath.isEmpty()) {
            Log.e(TAG, "installOTA: otaPath cannot be null or empty");
            return;
        }
        
        Log.i(TAG, "📦 Installing MTK OTA from: " + otaPath);
        
        Intent nn = new Intent("com.xy.updateota");
        nn.putExtra("cmd", "start");
        nn.putExtra("pkname", context.getPackageName());
        nn.putExtra("path", otaPath);
        nn.setPackage("com.android.systemui");
        context.sendBroadcast(nn);
        
        Log.d(TAG, "✅ MTK OTA install broadcast sent");
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

    public static void setI2SAudioPlayReceiverPackage(Context context, String packageName) {
        Intent nn = new Intent();
        nn.putExtra("cmd", "i2s_pkname");
        nn.putExtra("pkname", packageName);
        sendBroadcast(context, nn);
        Log.d(TAG, "Registered I2S audio receiver package: " + packageName);
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
    
    // Hardware LED Control Methods (device-agnostic)
    public static void setRecordingLedOn(Context context, boolean on) {
        try {
            IHardwareManager hardwareManager = HardwareManagerFactory.getInstance(context);
            if (on) {
                hardwareManager.setRecordingLedOn();
                Log.d(TAG, "Recording LED turned ON via SysControl");
            } else {
                hardwareManager.setRecordingLedOff();
                Log.d(TAG, "Recording LED turned OFF via SysControl");
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to control recording LED", e);
        }
    }
    
    public static void setRecordingLedBlinking(Context context, boolean blink) {
        try {
            IHardwareManager hardwareManager = HardwareManagerFactory.getInstance(context);
            if (blink) {
                hardwareManager.setRecordingLedBlinking();
                Log.d(TAG, "Recording LED set to BLINKING via SysControl");
            } else {
                hardwareManager.setRecordingLedOff();
                Log.d(TAG, "Recording LED turned OFF via SysControl");
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to control recording LED blinking", e);
        }
    }
    
    public static void flashRecordingLed(Context context, long durationMs) {
        try {
            IHardwareManager hardwareManager = HardwareManagerFactory.getInstance(context);
            hardwareManager.flashRecordingLed(durationMs);
            Log.d(TAG, "Recording LED flashed for " + durationMs + "ms via SysControl");
        } catch (Exception e) {
            Log.e(TAG, "Failed to flash recording LED", e);
        }
    }
    
    /**
     * Get system OTA version (MTK firmware version)
     * Reads the ro.custom.ota.version system property which contains the MTK OTA version.
     * @param context Application context
     * @return System OTA version string (format: YYYYMMDD, e.g., "20241130") or default "20241130" if not available
     */
    public static String getSystemCurrentVersion(Context context) {
        String VERSION_CUSTOM = "ro.custom.ota.version";
        String ver = "";
        try {
            ver = SysProp.get(context, VERSION_CUSTOM);
        } catch (Exception e) {
            Log.w(TAG, "Error reading system OTA version property", e);
        }
        
        String version = ver;
        if (ver == null || ver.length() < 8) {
            // Default fallback version (matches K900_server behavior)
            version = "20241130";
            Log.d(TAG, "System OTA version not available or invalid, using default: " + version);
        }
        
        return version;
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
