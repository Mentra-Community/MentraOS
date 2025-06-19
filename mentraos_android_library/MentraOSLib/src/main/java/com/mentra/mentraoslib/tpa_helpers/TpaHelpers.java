package com.mentra.mentraoslib.tpa_helpers;

import static com.mentra.mentraoslib.AugmentOSGlobalConstants.AugmentOSManagerPackageName;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;

public class TpaHelpers {
    public static boolean redirectToAugmentOsManagerIfAvailable(Context context){
        if (isAppInstalled(context, AugmentOSManagerPackageName)) {
            launchTargetApp(context, AugmentOSManagerPackageName);
            return true;
        } else {
            return false;
        }
    }
    public static boolean isAppInstalled(Context context, String packageName) {
        PackageManager pm = context.getPackageManager();
        try {
            pm.getPackageInfo(packageName, PackageManager.GET_ACTIVITIES);
            return true;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }

    private static void launchTargetApp(Context context, String packageName) {
        PackageManager pm = context.getPackageManager();
        Intent launchIntent = pm.getLaunchIntentForPackage(packageName);

        if (launchIntent != null) {
            context.startActivity(launchIntent);
           // if (context instanceof Activity) {
           //     ((Activity) context).finish();
           // }
        } else {
            // Handle the case where the app is installed but cannot be launched
            Uri playStoreUri = Uri.parse("https://play.google.com/store/apps/details?id=" + packageName);
            Intent intent = new Intent(Intent.ACTION_VIEW, playStoreUri);
            context.startActivity(intent);
        }
    }
}
