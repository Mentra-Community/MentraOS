package com.augmentos.augmentos

import android.app.Application
import android.content.IntentFilter
import androidx.localbroadcastmanager.content.LocalBroadcastManager
import com.BV.LinearGradient.LinearGradientPackage
import com.facebook.react.ReactApplication
import com.facebook.react.ReactInstanceEventListener
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.ReactContext
import com.facebook.react.shell.MainReactPackage
import com.facebook.soloader.SoLoader
import com.horcrux.svg.SvgPackage
import com.reactnativecommunity.asyncstorage.AsyncStoragePackage
import com.swmansion.gesturehandler.RNGestureHandlerPackage
import com.swmansion.reanimated.ReanimatedPackage
import com.swmansion.rnscreens.RNScreensPackage
import com.th3rdwave.safeareacontext.SafeAreaContextPackage
import com.zoontek.rnpermissions.RNPermissionsPackage
import it.innove.BleManagerPackage
import kjd.reactnative.bluetooth.RNBluetoothClassicPackage
import com.reactnativecommunity.slider.ReactSliderPackage
import com.lugg.RNCConfig.RNCConfigPackage
import org.reactnative.camera.RNCameraPackage
import com.augmentos.augmentos.logcapture.LogcatCapturePackage
import com.reactnativecommunity.webview.RNCWebViewPackage
import com.rnfs.RNFSPackage
import com.brentvatne.react.ReactVideoPackage
import fr.greweb.reactnativeviewshot.RNViewShotPackage
import com.reactlibrary.createthumbnail.CreateThumbnailPackage

// import com.augmentos.augmentos.NotificationServicePackage

class MainApplication : Application(), ReactApplication {

    override val reactNativeHost: ReactNativeHost = object : ReactNativeHost(this) {
        override fun getUseDeveloperSupport(): Boolean {
            return BuildConfig.DEBUG
        }

        override fun getPackages(): List<ReactPackage> {
            return listOf(
                MainReactPackage(),
                RNBluetoothClassicPackage(),
                BleManagerPackage(),
                ReanimatedPackage(),
                RNScreensPackage(),
                SafeAreaContextPackage(),
                LinearGradientPackage(),
                RNGestureHandlerPackage(),
                RNPermissionsPackage(),
                CoreCommsServicePackage(), // New Core Communications Package
                CoreServiceStarterPackage(),
                AsyncStoragePackage(),
                SvgPackage(),
                NotificationServicePackage(),
                InstallApkPackage(),
                ReactSliderPackage(),
                NotificationAccessPackage(),
                TpaHelpersPackage(),
                FetchConfigHelperPackage(),
                RNCConfigPackage(),
                RNCameraPackage(),
                LogcatCapturePackage(),
                RNCWebViewPackage(),
                RNFSPackage(),
                ReactVideoPackage(),
                FileProviderPackage(),
                RNViewShotPackage(),
                CreateThumbnailPackage(),
            )
        }

        override fun getJSMainModuleName(): String {
            return "index"
        }
    }

    override fun onCreate() {
        super.onCreate()
        SoLoader.init(this, /* native exopackage */ false)
/*
        // Register a listener to set up notificationReceiver once React context is available
        reactNativeHost.reactInstanceManager.addReactInstanceEventListener(
            object : ReactInstanceEventListener {
                override fun onReactContextInitialized(reactContext: ReactContext) {
                    val notificationReceiver = NotificationReceiver(reactContext)
                    val filter = IntentFilter("NOTIFICATION_LISTENER")
                    LocalBroadcastManager.getInstance(this@MainApplication)
                        .registerReceiver(notificationReceiver, filter)
                }
            }
        )*/
    }
}
