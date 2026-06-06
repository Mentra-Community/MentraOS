package com.mentra.recovery.util;

import android.content.Context;
import android.content.Intent;
import android.util.Log;

import java.io.File;

public class SystemInstaller {
  private final Context context;

  public SystemInstaller(Context context) {
    this.context = context.getApplicationContext();
  }

  public boolean uninstallPackage(String packageName) {
    try {
      Intent intent = new Intent("com.xy.xsetting.action");
      intent.setPackage("com.android.systemui");
      intent.putExtra("cmd", "uninstall");
      intent.putExtra("pkname", packageName);
      context.sendBroadcast(intent);
      Log.i(RecoveryConstants.TAG, "Requested uninstall of " + packageName);
      return true;
    } catch (Exception e) {
      Log.e(RecoveryConstants.TAG, "Failed to send uninstall broadcast", e);
      return false;
    }
  }

  public boolean installApk(String apkPath, String receivePackage) {
    File apkFile = new File(apkPath);
    if (!apkFile.exists() || !apkFile.canRead()) {
      Log.e(RecoveryConstants.TAG, "APK missing or unreadable: " + apkPath);
      return false;
    }
    try {
      Intent intent = new Intent("com.xy.xsetting.action");
      intent.setPackage("com.android.systemui");
      intent.putExtra("cmd", "install");
      intent.putExtra("pkpath", apkPath);
      intent.putExtra("recv_pkname", receivePackage);
      intent.putExtra("startapp", true);
      context.sendBroadcast(intent);
      return true;
    } catch (Exception e) {
      Log.e(RecoveryConstants.TAG, "Failed to send install broadcast", e);
      return false;
    }
  }
}
