package com.mentra.mentra

import android.app.Application
import android.content.res.Configuration

import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactPackage
import com.facebook.react.ReactHost
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.load
import com.facebook.react.defaults.DefaultReactNativeHost
import com.facebook.react.soloader.OpenSourceMergedSoMapping
import com.facebook.soloader.SoLoader
import com.facebook.react.shell.MainReactPackage
import com.horcrux.svg.SvgPackage
import com.reactnativecommunity.asyncstorage.AsyncStoragePackage
import com.swmansion.gesturehandler.RNGestureHandlerPackage
import com.swmansion.reanimated.ReanimatedPackage
import com.swmansion.rnscreens.RNScreensPackage
import com.th3rdwave.safeareacontext.SafeAreaContextPackage
import com.zoontek.rnpermissions.RNPermissionsPackage
import it.innove.BleManagerPackage
// import kjd.reactnative.bluetooth.RNBluetoothClassicPackage
// import com.reactnativecommunity.slider.ReactSliderPackage
import com.lugg.RNCConfig.RNCConfigPackage
// import org.reactnative.camera.RNCameraPackage
import com.mentra.mentra.logcapture.LogcatCapturePackage
import com.reactnativecommunity.webview.RNCWebViewPackage
import com.rnfs.RNFSPackage
import com.brentvatne.react.ReactVideoPackage
import fr.greweb.reactnativeviewshot.RNViewShotPackage
import com.reactlibrary.createthumbnail.CreateThumbnailPackage
import com.BV.LinearGradient.LinearGradientPackage

import expo.modules.ApplicationLifecycleDispatcher
import expo.modules.ReactNativeHostWrapper

class MainApplication : Application(), ReactApplication {

  override val reactNativeHost: ReactNativeHost = ReactNativeHostWrapper(
        this,
        object : DefaultReactNativeHost(this) {
          override fun getPackages(): List<ReactPackage> {
            val packages = PackageList(this).packages
            // Packages that cannot be autolinked yet can be added manually here, for example:
            // packages.add(new MyReactNativePackage());
            packages.add(MainReactPackage());
            packages.add(BleManagerPackage());
            packages.add(ReanimatedPackage());
            packages.add(RNScreensPackage());
            packages.add(SafeAreaContextPackage());
            packages.add(LinearGradientPackage());
            packages.add(RNGestureHandlerPackage());
            packages.add(RNPermissionsPackage());
            packages.add(CoreCommsServicePackage()); // New Core Communications Package
            packages.add(CoreServiceStarterPackage());
            packages.add(AsyncStoragePackage());
            packages.add(SvgPackage());
            packages.add(NotificationServicePackage());
            packages.add(InstallApkPackage());
            // packages.add(ReactSliderPackage());
            packages.add(NotificationAccessPackage());
            packages.add(TpaHelpersPackage());
            packages.add(FetchConfigHelperPackage());
            packages.add(RNCConfigPackage());
            // packages.add(RNCameraPackage());
            packages.add(LogcatCapturePackage());
            packages.add(RNCWebViewPackage());
            packages.add(RNFSPackage());
            packages.add(ReactVideoPackage());
            packages.add(FileProviderPackage());
            packages.add(RNViewShotPackage());
            packages.add(CreateThumbnailPackage());
            return packages
          }

          override fun getJSMainModuleName(): String = ".expo/.virtual-metro-entry"

          override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEBUG

          override val isNewArchEnabled: Boolean = BuildConfig.IS_NEW_ARCHITECTURE_ENABLED
          override val isHermesEnabled: Boolean = BuildConfig.IS_HERMES_ENABLED
      }
  )

  override val reactHost: ReactHost
    get() = ReactNativeHostWrapper.createReactHost(applicationContext, reactNativeHost)

  override fun onCreate() {
    super.onCreate()
    SoLoader.init(this, OpenSourceMergedSoMapping)
    if (BuildConfig.IS_NEW_ARCHITECTURE_ENABLED) {
      // If you opted-in for the New Architecture, we load the native entry point for this app.
      load()
    }
    ApplicationLifecycleDispatcher.onApplicationCreate(this)
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    ApplicationLifecycleDispatcher.onConfigurationChanged(this, newConfig)
  }
}
