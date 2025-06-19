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
package com.augmentos.augmentos_core;

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
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.ContextCompat;
import androidx.navigation.NavController;
import androidx.navigation.fragment.NavHostFragment;
import androidx.preference.PreferenceManager;

// import com.firebase.ui.auth.AuthUI;
import com.augmentos.augmentos_core.events.SignOutEvent;
import com.augmentos.augmentos_core.ui.UiUtils;
import com.augmentos.augmentos_core.smarterglassesmanager.supportedglasses.SmartGlassesDevice;
import com.augmentos.augmentos_core.smarterglassesmanager.utils.PermissionsUtils;
import android.media.projection.MediaProjectionManager;

import org.greenrobot.eventbus.Subscribe;

public class MainActivity extends AppCompatActivity {
  public final String TAG = "Augmentos_MainActivity";
  public AugmentosService mService;
  boolean mBound;
  private NavController navController;
  PermissionsUtils permissionsUtils;

  //Permissions
  private static final int PERMISSIONS_REQUEST_RECORD_AUDIO = 1;
  private static final int PICK_CONTACT_REQUEST = 1;
  private static final int READ_CONTACTS_PERMISSIONS_REQUEST = 2;

  public SmartGlassesDevice selectedDevice;
  private static final String TARGET_PACKAGE = "com.augmentos.augmentos";


  public boolean gettingPermissions = false;

  @SuppressLint("ClickableViewAccessibility")
  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    //if (isAppInstalled(TARGET_PACKAGE)) {
      setContentView(R.layout.activity_main);
      //launchTargetApp(TARGET_PACKAGE);
    //} else {
      // Show a message or handle the case where the target app is not installed
    //  setContentView(R.layout.activity_main);
    //}
    mBound = false;

    permissionsUtils = new PermissionsUtils(this, TAG);
    permissionsUtils.getSomePermissions();
    if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
        != PackageManager.PERMISSION_GRANTED) {
      gettingPermissions = true;
    }

    //setup the nav bar
    NavHostFragment navHostFragment = (NavHostFragment) getSupportFragmentManager().findFragmentById(R.id.nav_host_fragment);
    Log.d(TAG, getSupportFragmentManager().getFragments().toString());
    navController = navHostFragment.getNavController();

    // Handle the deep link intent
    Intent intent = getIntent();
    Uri data = intent.getData();

    if (data != null) {
      Log.d(TAG, "Deep link URI: " + data.toString());

      // Extract query parameters if needed
      String sourcePackage = data.getQueryParameter("sourcePackage");
      if (sourcePackage != null) {
        Log.d(TAG, "Source Package: " + sourcePackage);
        // TODO: You can perform actions based on the source package here
      }

      // Implement additional logic based on the deep link
      // For example, navigate to a specific fragment or display certain content
    }
  }

  @Override
  public void onStart() {
    super.onStart();
    UiUtils.setupTitle(this, "AugmentOS Core");

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
//    UiUtils.setupTitle(this, defaultFragmentLabel);
    //register receiver that gets data from the service

    if (isMyServiceRunning(AugmentosService.class)) {
      //bind to WearableAi service
      bindAugmentosService();

      //ask the service to send us all the Augmentos responses
      if (mService != null) {
        //mService.sendUiUpdateFull();
      }
    }
  }

  @Override
  protected void onPause() {
    super.onPause();

    //unbind wearableAi service
    unbindAugmentosService();
  }

  public void restartAugmentosServiceIfRunning() {
    if (!isMyServiceRunning(AugmentosService.class)) return;
    stopAugmentosService();
    Handler starter = new Handler();
    starter.postDelayed(new Runnable() {
      @Override
      public void run() {
        startAugmentosService();
      }
    }, 300);
  }

  public void restartAugmentosService() {
    stopAugmentosService();
    Handler starter = new Handler();
    starter.postDelayed(new Runnable() {
      @Override
      public void run() {
        startAugmentosService();
      }
    }, 300);
  }

  public void stopAugmentosService() {
    unbindAugmentosService();
    if (!isMyServiceRunning(AugmentosService.class)) return;
    Intent stopIntent = new Intent(this, AugmentosService.class);
    stopIntent.setAction(AugmentosService.ACTION_STOP_FOREGROUND_SERVICE);
    startService(stopIntent);
  }

  public void sendAugmentosServiceMessage(String message) {
    if (!isMyServiceRunning(AugmentosService.class)) return;
    Intent messageIntent = new Intent(this, AugmentosService.class);
    messageIntent.setAction(message);
    startService(messageIntent);
  }

  public void startAugmentosService() {
    if (isMyServiceRunning(AugmentosService.class)){
      Log.d(TAG, "Not starting Augmentos service because it's already started.");
      return;
    }

    Log.d(TAG, "Starting Augmentos service.");
    Intent startIntent = new Intent(this, AugmentosService.class);
    startIntent.setAction(AugmentosService.ACTION_START_FOREGROUND_SERVICE);
    startService(startIntent);
    bindAugmentosService();
  }

  public boolean isAugmentosServiceRunning(){
    return isMyServiceRunning(AugmentosService.class);
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

  public void bindAugmentosService(){
    if (!mBound){
      Intent intent = new Intent(this, AugmentosService.class);
      bindService(intent, augmentosCoreAppServiceConnection, Context.BIND_AUTO_CREATE);
    }
  }

  public void unbindAugmentosService() {
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
      AugmentosService.LocalBinder augmentOsServiceBinder = (AugmentosService.LocalBinder) service;
      mService = (AugmentosService) augmentOsServiceBinder.getService();
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
  public void requestScreenCapturePermission() {
    if (!isScreenCaptureServiceRunning()) {
      MediaProjectionManager projectionManager = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
      Intent captureIntent = projectionManager.createScreenCaptureIntent();
      startActivityForResult(captureIntent, REQUEST_CODE_CAPTURE);
    } else {
      Toast.makeText(this, "Screen capture is already active", Toast.LENGTH_SHORT).show();
    }
  }

  public boolean isScreenCaptureServiceRunning() {
    ActivityManager manager = (ActivityManager) getSystemService(Context.ACTIVITY_SERVICE);
    for (ActivityManager.RunningServiceInfo service : manager.getRunningServices(Integer.MAX_VALUE)) {
      if (ScreenCaptureService.class.getName().equals(service.service.getClassName())) {
        return true;
      }
    }
    return false;
  }

  @Override
  protected void onActivityResult(int requestCode, int resultCode, Intent data) {
    super.onActivityResult(requestCode, resultCode, data);
    if (requestCode == REQUEST_CODE_CAPTURE) {
      if (resultCode == RESULT_OK && data != null) {
        Intent serviceIntent = new Intent(this, ScreenCaptureService.class);
        serviceIntent.putExtra("resultCode", resultCode);
        serviceIntent.putExtra("data", data);
        startService(serviceIntent);
      } else {
        Toast.makeText(this, "Permission Denied or Request Cancelled", Toast.LENGTH_SHORT).show();
      }
    }
//    if (requestCode == PICK_CONTACT_REQUEST && resultCode == RESULT_OK) {
//      Uri contactUri = data.getData();
//
//      // Perform another query to get the contact's details
//      Cursor cursor = getContentResolver().query(contactUri, null,
//              null, null, null);
//
//      if (cursor != null && cursor.moveToFirst()) {
//        String id = cursor.getString(cursor.getColumnIndexOrThrow(ContactsContract.Contacts._ID));
//
//        Cursor phones = getContentResolver().query(
//                ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
//                null,
//                ContactsContract.CommonDataKinds.Phone.CONTACT_ID + " = " + id,
//                null, null);
//
//        while (phones != null && phones.moveToNext()) {
//          @SuppressLint("Range") String phoneNumber = phones.getString(phones.getColumnIndex(ContactsContract.CommonDataKinds.Phone.NUMBER));
//          @SuppressLint("Range") String name = phones.getString(phones.getColumnIndex(ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME));
//          Toast.makeText(this, "Phone number: " + phoneNumber, Toast.LENGTH_LONG).show();
//          EventBus.getDefault().post(new SharingContactChangedEvent(name, phoneNumber));
//        }
//
//        cursor.close();
//
//        if (phones != null) {
//          phones.close();
//        }
//      }
//    }
  }

  public void stopScreenCapture() {
    Intent serviceIntent = new Intent(this, ScreenCaptureService.class);
    stopService(serviceIntent);
  }

  @Override
  public boolean onSupportNavigateUp() {
    onBackPressed();
    return true;
  }

  public void setSavedAuthToken(Context context, String newAuthToken){
    PreferenceManager.getDefaultSharedPreferences(context)
            .edit()
            .putString("auth_token", newAuthToken)
            .apply();
  }

  @Subscribe
  public void onSignOutEvent(SignOutEvent event){
    signOut();
  }

  public void signOut(){
    setSavedAuthToken(getApplicationContext(), "");
//    AuthUI.getInstance()
//            .signOut(this)
//            .addOnCompleteListener(new OnCompleteListener<Void>() {
//              public void onComplete(@NonNull Task<Void> task) {
//                Log.d(TAG, "LOGGED OUT (SUCCESSFULLY)");
//                stopService(new Intent(MainActivity.this, AugmentosService.class));
//                NavOptions navOptions = new NavOptions.Builder()
//                        .setPopUpTo(R.id.nav_landing, true) // Replace 'nav_graph_start_destination' with the ID of your start destination in the nav graph
//                        .build();
//                navController.navigate(R.id.nav_landing, null, navOptions);
//              }
//            })
//            .addOnFailureListener(new OnFailureListener() {
//              @Override
//              public void onFailure(@NonNull Exception e) {
//                Log.d(TAG, "LOGGED OUT (WITH ERROR)");
//                stopService(new Intent(MainActivity.this, AugmentosService.class));
//                NavOptions navOptions = new NavOptions.Builder()
//                        .setPopUpTo(R.id.nav_landing, true) // Replace 'nav_graph_start_destination' with the ID of your start destination in the nav graph
//                        .build();
//                navController.navigate(R.id.nav_landing, null, navOptions);
//              }
//            });
  }

//  public void connectSmartGlasses(SmartGlassesDevice device){
//    this.selectedDevice = device;
//
//    //check if the service is running. If not, we should start it first, so it doesn't die when we unbind
//    if (!isMyServiceRunning(AugmentosService.class)){
//      Log.e(TAG, "Something went wrong, service should be started and bound.");
//    } else {
//      mService.connectToSmartGlasses(device);
//    }
//  }

//  public void openGlassesSelector() {
//    SelectSmartGlassesUi selectorFragment = new SelectSmartGlassesUi();
//    FragmentTransaction transaction = getSupportFragmentManager().beginTransaction();
//    transaction.replace(com.augmentos.augmentos_core.R.id.main_container, selectorFragment);
//    transaction.addToBackStack(null); // Add to back stack for back button support
//    transaction.commit();
//  }

  public boolean isAppInstalled(String packageName) {
    PackageManager pm = getPackageManager();
    try {
      pm.getPackageInfo(packageName, PackageManager.GET_ACTIVITIES);
      return true;
    } catch (PackageManager.NameNotFoundException e) {
      return false;
    }
  }

  public void launchTargetApp(String packageName) {
    PackageManager pm = getPackageManager();
    Intent launchIntent = pm.getLaunchIntentForPackage(packageName);

    if (launchIntent != null) {
      startActivity(launchIntent);
      finish(); // Optional: Close this app if switching to the target app
    } else {
      // Handle the case where the app is installed but cannot be launched
      Uri playStoreUri = Uri.parse("https://play.google.com/store/apps/details?id=" + packageName);
      Intent intent = new Intent(Intent.ACTION_VIEW, playStoreUri);
      startActivity(intent);
    }
  }

}
