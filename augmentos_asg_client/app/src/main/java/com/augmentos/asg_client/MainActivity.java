/*
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.augmentos.asg_client;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.ActivityManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatDelegate;

import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.util.Log;
import android.view.Surface;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.ContextCompat;
import androidx.preference.PreferenceManager;

// import com.firebase.ui.auth.AuthUI;
import com.augmentos.asg_client.AsgClientService;
import com.augmentos.augmentos_core.smarterglassesmanager.utils.PermissionsUtils;

import android.media.projection.MediaProjectionManager;

import org.greenrobot.eventbus.Subscribe;

public class MainActivity extends AppCompatActivity {
  public final String TAG = "Augmentos_MainActivity";
  public AsgClientService mService;
  boolean mBound;
  PermissionsUtils permissionsUtils;
  
  //Permissions
  private static final int PERMISSIONS_REQUEST_RECORD_AUDIO = 1;
  private static final int PICK_CONTACT_REQUEST = 1;
  private static final int READ_CONTACTS_PERMISSIONS_REQUEST = 2;

  public boolean gettingPermissions = false;

  @SuppressLint("ClickableViewAccessibility")
  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    startAsgClientService();
    mBound = false;

    permissionsUtils = new PermissionsUtils(this, TAG);
    permissionsUtils.getSomePermissions();
    
    if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      gettingPermissions = true;
      permissionsUtils.getSomePermissions();
    }

    // Set layout for launcher
    setContentView(R.layout.activity_main);
  }
  

  @Override
  public void onStart() {
    super.onStart();


    if (permissionsUtils == null) {
      permissionsUtils = new PermissionsUtils(this, TAG);
    }

    if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
        != PackageManager.PERMISSION_GRANTED) {
      gettingPermissions = true;
      permissionsUtils.getSomePermissions();
      //ActivityCompat.requestPermissions(:w
      // this, new String[] {Manifest.permission.RECORD_AUDIO}, PERMISSIONS_REQUEST_RECORD_AUDIO);
      }
  }

  @Override
  public void onStop() {
    super.onStop();
  }

  @Override
  public void onDestroy() {
    super.onDestroy();
  }

  @Override
  public void onRequestPermissionsResult(
          int requestCode, String[] permissions, int[] grantResults) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults);
    switch (requestCode) {
      case PERMISSIONS_REQUEST_RECORD_AUDIO:
        // If request is cancelled, the result arrays are empty.
        if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
          // Permission granted, proceed with app initialization
        } else {
          // Show toast but don't force close
          Toast.makeText(
                          this,
                          "This app requires Microphone permission to function properly.",
                          Toast.LENGTH_LONG)
                  .show();
        }
        return;
      case READ_CONTACTS_PERMISSIONS_REQUEST:
        if (grantResults.length > 0 &&
                grantResults[0] == PackageManager.PERMISSION_GRANTED) {
          //pickContact();
        } else {
          Toast.makeText(this, "Permission to read contacts denied", Toast.LENGTH_SHORT).show();
        }
      default: // Should not happen. Something we did not request.
    }
  }

  @Override
  public void onConfigurationChanged(@NonNull Configuration newConfig) {
    super.onConfigurationChanged(newConfig);
    // Check for night mode status and apply theme accordingly
    int nightModeFlags = newConfig.uiMode & Configuration.UI_MODE_NIGHT_MASK;
    switch (nightModeFlags) {
      case Configuration.UI_MODE_NIGHT_YES:
        AppCompatDelegate.setDefaultNightMode(AppCompatDelegate.MODE_NIGHT_YES);
        break;
      case Configuration.UI_MODE_NIGHT_NO:
        AppCompatDelegate.setDefaultNightMode(AppCompatDelegate.MODE_NIGHT_NO);
        break;
      case Configuration.UI_MODE_NIGHT_UNDEFINED:
        break;
    }
  }

  @Override
  protected void onResume() {
    super.onResume();
    
    // Make the launcher fullscreen
    getWindow().getDecorView().setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    
    // Bind to service if running
    if (isMyServiceRunning(AsgClientService.class)) {
      bindAsgClientService();
      
      if (mService != null) {
        //mService.sendUiUpdateFull();
      }
    }
    
  }

  @Override
  protected void onPause() {
    super.onPause();

    //unbind service
    unbindAsgClientService();
  }

  public void restartAsgClientServiceIfRunning() {
    if (!isMyServiceRunning(AsgClientService.class)) return;
    stopAsgClientService();
    Handler starter = new Handler();
    starter.postDelayed(new Runnable() {
      @Override
      public void run() {
        startAsgClientService();
      }
    }, 300);
  }

  public void restartAsgClientService() {
    stopAsgClientService();
    Handler starter = new Handler();
    starter.postDelayed(new Runnable() {
      @Override
      public void run() {
        startAsgClientService();
      }
    }, 300);
  }

  public void stopAsgClientService() {
    unbindAsgClientService();
    if (!isMyServiceRunning(AsgClientService.class)) return;
    Intent stopIntent = new Intent(this, AsgClientService.class);
    stopIntent.setAction(AsgClientService.ACTION_STOP_FOREGROUND_SERVICE);
    
    // For Android O+, use startForegroundService 
    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
      startForegroundService(stopIntent);
    } else {
      startService(stopIntent);
    }
  }

  public void sendAsgClientServiceMessage(String message) {
    if (!isMyServiceRunning(AsgClientService.class)) return;
    Intent messageIntent = new Intent(this, AsgClientService.class);
    messageIntent.setAction(message);
    
    // For Android O+, use startForegroundService
    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
      startForegroundService(messageIntent);
    } else {
      startService(messageIntent);
    }
  }

  public void startAsgClientService() {
    if (isMyServiceRunning(AsgClientService.class)){
      Log.d(TAG, "Not starting Augmentos service because it's already started.");
      return;
    }

    Log.d(TAG, "Starting Augmentos service.");
    Intent startIntent = new Intent(this, AsgClientService.class);
    startIntent.setAction(AsgClientService.ACTION_START_FOREGROUND_SERVICE);
    
    // Use startForegroundService instead of startService for Android O+
    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
      Log.d(TAG, "Using startForegroundService for Android O+");
      startForegroundService(startIntent);
    } else {
      startService(startIntent);
    }
    
    bindAsgClientService();
  }

  public boolean isAsgClientServiceRunning(){
    return isMyServiceRunning(AsgClientService.class);
  }

  //check if service is running
  private boolean isMyServiceRunning(Class<?> serviceClass) {
    ActivityManager manager = (ActivityManager) getSystemService(Context.ACTIVITY_SERVICE);
    for (ActivityManager.RunningServiceInfo service : manager.getRunningServices(Integer.MAX_VALUE)) {
      if (serviceClass.getName().equals(service.service.getClassName())) {
        return true;
      }
    }
    return false;
  }

  public void bindAsgClientService(){
    if (!mBound){
      Intent intent = new Intent(this, AsgClientService.class);
      bindService(intent, augmentosCoreAppServiceConnection, Context.BIND_AUTO_CREATE);
    }
  }

  public void unbindAsgClientService() {
    if (mBound){
      unbindService(augmentosCoreAppServiceConnection);
      mBound = false;
    }
  }

  /** Defines callbacks for service binding, passed to bindService() */
  private ServiceConnection augmentosCoreAppServiceConnection = new ServiceConnection() {
    @Override
    public void onServiceConnected(ComponentName className,
                                   IBinder service) {
      // We've bound to LocalService, cast the IBinder and get LocalService instance
      AsgClientService.LocalBinder augmentOsServiceBinder = (AsgClientService.LocalBinder) service;
      mService = (AsgClientService) augmentOsServiceBinder.getService();
      mBound = true;

      //get update for UI
     // mService.sendUiUpdateFull();
    }
    @Override
    public void onServiceDisconnected(ComponentName arg0) {
      mBound = false;
    }
  };

  private static final int REQUEST_CODE_CAPTURE = 100;


  public void setSavedAuthToken(Context context, String newAuthToken){
    PreferenceManager.getDefaultSharedPreferences(context)
            .edit()
            .putString("auth_token", newAuthToken)
            .apply();
  }

  @Override
  public void onWindowFocusChanged(boolean hasFocus) {
    super.onWindowFocusChanged(hasFocus);
    if (hasFocus) {
      getWindow().getDecorView().setSystemUiVisibility(
              View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                      | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                      | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                      | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                      | View.SYSTEM_UI_FLAG_FULLSCREEN
                      | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }
  }
}
