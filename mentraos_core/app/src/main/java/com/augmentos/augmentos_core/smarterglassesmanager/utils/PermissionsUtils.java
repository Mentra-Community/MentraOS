package com.augmentos.augmentos_core.smarterglassesmanager.utils;

import android.Manifest;
import android.app.AlertDialog;
import android.content.DialogInterface;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

//handle all of the permissions stuff
public class PermissionsUtils {
    private AppCompatActivity mCallingActivity;
    private String TAG;

    public PermissionsUtils(AppCompatActivity callingActivity, String tag){
        mCallingActivity = callingActivity;
        TAG = tag;
    }

    //permissions
    //file storage and SMS permissions
    public final String[] EXTERNAL_PERMS = {Manifest.permission.WRITE_EXTERNAL_STORAGE, Manifest.permission.READ_EXTERNAL_STORAGE};
    public final int EXTERNAL_REQUEST = 138;

    //location permissions
    //private int LOCATION_PERMISSION_CODE = 1;
    private int REQUEST_PERMISSION_CODE = 1;
    private int BACKGROUND_LOCATION_PERMISSION_CODE = 2;

    //handle permissions
    public boolean requestFilesPermission() {
        boolean isPermissionOn = true;
        final int version = Build.VERSION.SDK_INT;
        if (version >= 23) {
            if (!canAccessExternalSd()) {
                isPermissionOn = false;
              mCallingActivity.requestPermissions(EXTERNAL_PERMS, EXTERNAL_REQUEST);
            }
        }
        return isPermissionOn;
    }

    public boolean canAccessExternalSd() {
        return (hasPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE));
    }

    private boolean hasPermission(String perm) {
        return (PackageManager.PERMISSION_GRANTED == ContextCompat.checkSelfPermission(mCallingActivity, perm));

    }

    public void checkPermission() {
        if (ContextCompat.checkSelfPermission(mCallingActivity, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
            // Fine Location permission is granted
            // Check if current android version >= 11, if >= 11 check for Background Location permission
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                if (ContextCompat.checkSelfPermission(mCallingActivity, Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED) {
                    // Background Location Permission is granted so do your work here
                    //now, get file permissions
                    requestFilesPermission();
                } else {
                    // Ask for Background Location Permission
                    askPermissionForBackgroundUsage();
                }
            }
        } else {
            // Fine Location Permission is not granted so ask for permission
            askForLocationPermission();
        }
    }

    private void askForLocationPermission() {
        Log.d(TAG, "run askForLocationPermission");
        if (ActivityCompat.shouldShowRequestPermissionRationale(mCallingActivity, Manifest.permission.ACCESS_FINE_LOCATION)) {
            new AlertDialog.Builder(mCallingActivity)
                    .setTitle("Permission Needed!")
                    .setMessage("Location Permission Needed!")
                    .setPositiveButton("OK", new DialogInterface.OnClickListener() {
                        @Override
                        public void onClick(DialogInterface dialog, int which) {
                            ActivityCompat.requestPermissions(mCallingActivity,
                                    new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.BLUETOOTH_CONNECT,Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.RECORD_AUDIO}, REQUEST_PERMISSION_CODE);
                        }
                    })
                    .setNegativeButton("CANCEL", new DialogInterface.OnClickListener() {
                        @Override
                        public void onClick(DialogInterface dialog, int which) {
                            // Permission is denied by the user
                        }
                    })
                    .create().show();
        } else {
            ActivityCompat.requestPermissions(mCallingActivity,
                    new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.BLUETOOTH_CONNECT,Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.RECORD_AUDIO}, REQUEST_PERMISSION_CODE);
        }
    }

    private void askPermissionForBackgroundUsage() {
        Log.d(TAG, "run askPermissionForBackgroundUsage");
        if (ActivityCompat.shouldShowRequestPermissionRationale(mCallingActivity, Manifest.permission.ACCESS_BACKGROUND_LOCATION)) {
            new AlertDialog.Builder(mCallingActivity)
                    .setTitle("Location permissions needed.")
                    .setMessage("To tag memories and data based on where you were, the WIS app needs to collect location data. Many features won't work without location permissions. To allow, tap \"Allow all the time\" on the next screen.")
                    .setPositiveButton("OK", new DialogInterface.OnClickListener() {
                        @Override
                        public void onClick(DialogInterface dialog, int which) {
                            ActivityCompat.requestPermissions(mCallingActivity,
                                    new String[]{Manifest.permission.ACCESS_BACKGROUND_LOCATION}, BACKGROUND_LOCATION_PERMISSION_CODE);
                        }
                    })
                    .setNegativeButton("CANCEL", new DialogInterface.OnClickListener() {
                        @Override
                        public void onClick(DialogInterface dialog, int which) {
                            // User declined for Background Location Permission.
                        }
                    })
                    .create().show();
        } else {
            ActivityCompat.requestPermissions(mCallingActivity,
                    new String[]{Manifest.permission.ACCESS_BACKGROUND_LOCATION}, BACKGROUND_LOCATION_PERMISSION_CODE);
        }
    }

    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] grantResults) {
        if (requestCode == REQUEST_PERMISSION_CODE) {
            if (grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                // User granted location permission
                // Now check if android version >= 11, if >= 11 check for Background Location Permission
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    if (ContextCompat.checkSelfPermission(mCallingActivity, Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED) {
                        // Background Location Permission is granted so do your work here
                        //now, get file permissions
                        requestFilesPermission();
                    } else {
                        // Ask for Background Location Permission
                        askPermissionForBackgroundUsage();
                    }
                }
            } else {
                // User denied location permission
            }
        } else if (requestCode == BACKGROUND_LOCATION_PERMISSION_CODE) {
            //now, get file permissions
            requestFilesPermission();
            if (grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            }
        }
    }

    public void getSomePermissions(){
        ActivityCompat.requestPermissions(mCallingActivity,
                new String[]{
                        Manifest.permission.ACCESS_FINE_LOCATION,
                        android.Manifest.permission.BLUETOOTH_SCAN,
                        android.Manifest.permission.BLUETOOTH_CONNECT,
                        Manifest.permission.BLUETOOTH_ADVERTISE,
                        android.Manifest.permission.RECORD_AUDIO,
//                        android.Manifest.permission.READ_PHONE_STATE
                }, REQUEST_PERMISSION_CODE);

        //TODO
//        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(mCallingActivity)) {
//            Log.d(TAG, "Requesting overlay permission");
//            Intent overlayIntent = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
//                    Uri.parse("package:" + mCallingActivity));
//            overlayIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
//            mCallingActivity.startActivity(overlayIntent);
//        }
    }
}
