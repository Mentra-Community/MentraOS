package com.augmentos.augmentos

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

import android.content.Intent
import android.os.Bundle
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.Arguments
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.bridge.WritableMap

class MainActivity : ReactActivity() {

  // Pass `null` to avoid restoring Screen fragments,
  // which react-native-screens does not support
  // For reference: this onCreate block solves a critical error for our large base of
  // Motorola Razr+ 2024 users, which causes the app to crash when opening/closing
  // the cover screen while AugmentOS Manager is open
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(null)
  }

  override fun getMainComponentName(): String = "AugmentOS"

  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)
}