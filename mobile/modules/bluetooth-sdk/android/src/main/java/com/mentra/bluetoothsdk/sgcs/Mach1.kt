package com.mentra.bluetoothsdk.sgcs

import android.content.Context
import android.content.res.Resources
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.drawable.Drawable
import android.os.Handler
import android.os.Looper
import android.util.Log

import androidx.lifecycle.LiveData
import androidx.lifecycle.Observer

// Mentra
import com.mentra.bluetoothsdk.DeviceManager
import com.mentra.bluetoothsdk.Bridge
import com.mentra.bluetoothsdk.PhotoRequest
import com.mentra.bluetoothsdk.utils.DeviceTypes
import com.mentra.bluetoothsdk.utils.ConnTypes
import com.mentra.bluetoothsdk.utils.BitmapJavaUtils
import com.mentra.bluetoothsdk.utils.SmartGlassesConnectionState
import com.mentra.bluetoothsdk.utils.K900ProtocolUtils
import com.mentra.bluetoothsdk.utils.MessageChunker
import com.mentra.bluetoothsdk.utils.audio.Lc3Player
import com.mentra.bluetoothsdk.utils.BlePhotoUploadService
import com.mentra.bluetoothsdk.DeviceStore

// import com.augmentos.augmentos_core.R;
// import com.augmentos.augmentos_core.smarterglassesmanager.smartglassescommunicators.SmartGlassesCommunicator;
// import com.augmentos.augmentos_core.smarterglassesmanager.smartglassescommunicators.SmartGlassesFontSize;
// import com.augmentos.augmentos_core.smarterglassesmanager.utils.SmartGlassesConnectionState;
import com.squareup.picasso.Picasso
import com.squareup.picasso.Target
// import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.BatteryLevelEvent;
// import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.GlassesBluetoothSearchDiscoverEvent;
// import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.GlassesDisplayPowerEvent;
// import com.augmentos.augmentos_core.smarterglassesmanager.supportedglasses.SmartGlassesDevice;
import com.vuzix.ultralite.Anchor
import com.vuzix.ultralite.BatteryStatus
import com.vuzix.ultralite.EventListener
import com.vuzix.ultralite.Layout
import com.vuzix.ultralite.TextAlignment
import com.vuzix.ultralite.TextWrapMode
import com.vuzix.ultralite.UltraliteColor
import com.vuzix.ultralite.UltraliteSDK

import org.greenrobot.eventbus.EventBus

import java.util.ArrayList
import java.util.Arrays
import java.util.Collections


//communicate with ActiveLook smart glasses
class Mach1 : SGCManager() {

    companion object {
        private const val TAG = "WearableAi_UltraliteSGC"
        const val cardLingerTime = 15

        private const val TAP_DEBOUNCE_TIME = 80L // milliseconds

        @JvmStatic
        fun maybeReverseRTLString(text: String): String {
            val result = StringBuilder()
            val rtlBuffer = StringBuilder()

            for (c in text.toCharArray()) {
                if (isRTLCharacter(c)) {
                    rtlBuffer.append(c) // Append RTL characters to a buffer
                } else {
                    if (rtlBuffer.length > 0) {
                        result.append(rtlBuffer.reverse()) // Reverse and append RTL text when a non-RTL character is found
                        rtlBuffer.setLength(0) // Clear the buffer
                    }
                    result.append(c) // Append non-RTL characters directly to the result
                }
            }

            if (rtlBuffer.length > 0) {
                result.append(rtlBuffer.reverse()) // Append any remaining RTL text in reverse
            }

            return result.toString()
        }

        private fun isRTLCharacter(c: Char): Boolean {
            val block = Character.UnicodeBlock.of(c)
            return block == Character.UnicodeBlock.ARABIC ||
                    block == Character.UnicodeBlock.HEBREW ||
                    block == Character.UnicodeBlock.SYRIAC ||
                    block == Character.UnicodeBlock.ARABIC_SUPPLEMENT ||
                    block == Character.UnicodeBlock.THAANA ||
                    block == Character.UnicodeBlock.NKO ||
                    block == Character.UnicodeBlock.SAMARITAN ||
                    block == Character.UnicodeBlock.MANDAIC ||
                    block == Character.UnicodeBlock.ARABIC_EXTENDED_A
            // Add other RTL blocks as needed
        }
    }

    var ultraliteSdk: UltraliteSDK? = null
    var ultraliteCanvas: UltraliteSDK.Canvas? = null
    var ultraliteListener: UltraliteListener? = null
    var currentUltraliteLayout: Layout? = null
    var screenToggleOff = false //should we keep the screen off?
    var context: Context? = null

    private var rowTextsLiveNow: ArrayList<Int>? = null

    //ultralite pixel buffer on left side of screen
    var ultraliteLeftSidePixelBuffer = 40

    //handler to turn off screen
    var goHomeHandler: Handler? = null
    var goHomeRunnable: Runnable? = null

    //handler to turn off screen/toggle
    var screenOffHandler: Handler? = null
    var screenOffRunnable: Runnable? = null

    //handler to check battery life
    var batteryHandler: Handler? = null
    var batteryRunnable: Runnable? = null

    //handler to disconnect
    var killHandler: Handler? = null

    var hasUltraliteControl = false
    var screenIsClear = false
    var isHeadUp = false // Dashboard state toggled by taps
    // SmartGlassesDevice smartGlassesDevice;
    private var lastTapTime = 0L
    private var totalDashboardsIdk = 0

    private fun hasBattery(): Boolean {
        val level = DeviceStore.get("glasses", "batteryLevel")
        return level is Number && level.toInt() != -1
    }

    private fun updateConnectionState(state: String) {
        val isEqual = state == connectionState
        if (isEqual) {
            return
        }

        // Update the connection state
        DeviceStore.apply("glasses", "connectionState", state)

        if (state == ConnTypes.CONNECTED) {
            // Match iOS: only declare fully booted once we have battery info too
            if (hasBattery()) {
                DeviceStore.apply("glasses", "connected", true)
                DeviceStore.apply("glasses", "fullyBooted", true)
            }
        } else if (state == ConnTypes.DISCONNECTED) {
            DeviceStore.apply("glasses", "fullyBooted", false)
            DeviceStore.apply("glasses", "connected", false)
        }
    }

    override fun setMicEnabled(enabled: Boolean) {
    }

    override fun sortMicRanking(list: MutableList<String>): MutableList<String> {
        return list
    }

    override fun requestPhoto(request: PhotoRequest) {

    }

    override fun startStream(message: MutableMap<String, Any>) {

    }

    override fun stopStream() {

    }

    override fun sendStreamKeepAlive(message: MutableMap<String, Any>) {

    }

    override fun startVideoRecording(requestId: String, save: Boolean, sound: Boolean) {

    }

    override fun stopVideoRecording(requestId: String) {

    }

    override fun sendButtonPhotoSettings() {

    }

    override fun sendButtonVideoRecordingSettings() {

    }

    override fun sendButtonMaxRecordingTime() {

    }

    override fun sendCameraFovSetting() {
    }

    override fun setBrightness(level: Int, autoMode: Boolean) {
        Bridge.log("Mach1: setBrightness() - level: " + level + "%, autoMode: " + autoMode)
        updateGlassesBrightness(level)
        updateGlassesAutoBrightness(autoMode)
    }

    override fun clearDisplay() {
        Bridge.log("Mach1: clearDisplay()")
        blankScreen()
    }

    override fun sendText(text: String) {
        Bridge.log("Mach1: sendText() - text: " + text)
        displayTextWall(text)
    }

    override fun sendTextWall(text: String) {
        Bridge.log("Mach1: sendTextWall()")
        displayTextWall(text)
    }

    override fun sendDoubleTextWall(top: String, bottom: String) {
        Bridge.log("Mach1: sendDoubleTextWall()")
        displayDoubleTextWall(top, bottom)
    }

    override fun displayBitmap(base64ImageData: String, x: Int?, y: Int?, width: Int?, height: Int?): Boolean {
        try {
            Bridge.log("Mach1: displayBitmap() - decoding base64")
            // Decode base64 to byte array
            val bmpData = android.util.Base64.decode(base64ImageData, android.util.Base64.DEFAULT)

            if (bmpData == null || bmpData.isEmpty()) {
                Log.e(TAG, "Failed to decode base64 image data")
                return false
            }

            // Convert byte array to Bitmap
            val bitmap = BitmapFactory.decodeByteArray(bmpData, 0, bmpData.size)

            if (bitmap == null) {
                Log.e(TAG, "Failed to decode bitmap from byte array")
                return false
            }

            // Call internal implementation
            displayBitmap(bitmap)
            return true
        } catch (e: Exception) {
            Log.e(TAG, "Error displaying bitmap from base64", e)
            return false
        }
    }

    override fun showDashboard() {

    }

    override fun ping() {
    }

    override fun dbg1() {}

    override fun dbg2() {}

    override fun setDashboardPosition(height: Int, depth: Int) {

    }

    override fun setHeadUpAngle(angle: Int) {

    }

    override fun getBatteryStatus() {

    }

    override fun setSilentMode(enabled: Boolean) {

    }

    override fun exit() {

    }

    override fun sendShutdown() {
        Bridge.log("sendShutdown - not supported on Mach1")
    }

    override fun sendReboot() {
        Bridge.log("sendReboot - not supported on Mach1")
    }

    override fun sendRgbLedControl(requestId: String, packageName: String?, action: String, color: String?, onDurationMs: Int, offDurationMs: Int, count: Int) {
        Bridge.log("sendRgbLedControl - not supported on Mach1")
        Bridge.sendRgbLedControlResponse(requestId, false, "device_not_supported")
    }

    override fun disconnect() {
        Bridge.log("Mach1: disconnect()")
        if (ultraliteSdk != null) {
            ultraliteSdk!!.releaseControl()
            updateConnectionState(ConnTypes.DISCONNECTED)
        }
    }

    override fun forget() {
        Bridge.log("Mach1: forget()")
        // Release control and clean up
        destroy()
    }

    override fun findCompatibleDevices() {
        Bridge.log("Mach1: findCompatibleDevices()")
        findCompatibleDeviceNames()
    }

    override fun stopScan() {
        Bridge.log("Mach1: stopScan() - no active BLE scanner owned by Mach1")
    }

    override fun connectById(id: String) {
        Bridge.log("Mach1: connectById() - id: " + id)
        // The Mach1 uses UltraliteSDK which handles connection internally
        // We just need to trigger the connection process
        connectToSmartGlasses()
    }

    override fun getConnectedBluetoothName(): String {
        // Mach1/Ultralite SDK doesn't expose the peripheral name directly
        // Return device type if connected
        if (ultraliteSdk != null) {
            val connected = ultraliteSdk!!.getConnected()
            if (connected != null && java.lang.Boolean.TRUE == connected.value) {
                return "Vuzix Ultralite"
            }
        }
        return ""
    }

    override fun cleanup() {
        destroy()
    }

    override fun requestWifiScan(scanId: String?) {

    }

    override fun sendWifiCredentials(ssid: String, password: String) {

    }

    override fun forgetWifiNetwork(ssid: String) {
        // Mach1 doesn't support WiFi
    }

    override fun sendHotspotState(enabled: Boolean) {
        // Mach1 doesn't support hotspot
    }

    override fun sendUserEmailToGlasses(email: String) {
        // Mach1 doesn't support user email (no ASG client)
    }

    override fun sendIncidentId(incidentId: String, apiBaseUrl: String?) {
        // Mach1 doesn't support incident reporting (no ASG client)
    }

    override fun queryGalleryStatus() {

    }

    override fun sendGalleryMode() {
        // Mach1 doesn't have a built-in camera/gallery system
        Bridge.log("Mach1: sendGalleryModeActive - not supported on Mach1")
    }

    override fun requestVersionInfo() {
        // Mach1 doesn't support version info requests
        Bridge.log("Mach1: requestVersionInfo - not supported on Mach1")
    }

    inner class UltraliteListener : EventListener {
        override fun onTap(tapCount: Int) {
            val currentTime = System.currentTimeMillis()
            if (currentTime - lastTapTime < TAP_DEBOUNCE_TIME) {
                Log.d(TAG, "Ignoring duplicate tap event")
                return
            }
            totalDashboardsIdk++
            Log.d(TAG, "TOTAL NUMBER OF DASHBOARD TOGGLEZ: " + totalDashboardsIdk)

            lastTapTime = currentTime
            Log.d(TAG, "Ultralite go tap n times: " + tapCount)

            // Toggle dashboard on 2+ taps (same as iOS implementation)
            if (tapCount >= 2) {
                isHeadUp = !isHeadUp
                // Notify DeviceManager of head up state change (same as G1 does with IMU)
                DeviceStore.apply("glasses", "headUp", isHeadUp)
                Log.d(TAG, "Mach1: Dashboard toggled via tap, isHeadUp: " + isHeadUp)

                // Auto turn off the dashboard after 15 seconds
                if (isHeadUp) {
                    goHomeHandler!!.postDelayed({
                        if (isHeadUp) {
                            isHeadUp = false
                            DeviceStore.apply("glasses", "headUp", false)
                            Log.d(TAG, "Mach1: Auto-disabling dashboard after 15 seconds")
                        }
                    }, 15000L)
                }
            }
        }

        override fun onDisplayTimeout() {
            Log.d(TAG, "Ultralite display timeout.")
        }

        override fun onPowerButtonPress(turningOn: Boolean) {
            //since we implement our own state for the power turn on/off, we ignore what the ultralite thinks ('turningOn') and use our own state
            Log.d(TAG, "Ultralites power button pressed: " + turningOn)

            //flip value of screen toggle
            screenToggleOff = !screenToggleOff

            if (!screenToggleOff) {
                Log.d(TAG, "screen toggle off NOT on, showing turn ON message")
                // EventBus.getDefault().post(new GlassesDisplayPowerEvent(screenToggleOff));
            } else {
                Log.d(TAG, "screen toggle off IS on")
            }
        }
    }

    private var ultraliteConnectedLive: LiveData<Boolean>? = null
    private var ultraliteControlled: LiveData<Boolean>? = null
    private var batteryStatusObserver: LiveData<BatteryStatus>? = null

    // Observer references for cleanup
    private var connectedObserver: Observer<Boolean>? = null
    private var controlledObserver: Observer<Boolean>? = null
    private var batteryObserver: Observer<BatteryStatus?>? = null

    init {
        this.type = DeviceTypes.MACH1
        Log.d(TAG, "Mach1 constructor started")

        try {
            // Get context from Bridge (like G1 does)
            this.context = Bridge.getContext()
            Log.d(TAG, "Mach1: Got context from Bridge")

            hasUltraliteControl = false
            screenIsClear = true
            goHomeHandler = Handler(Looper.getMainLooper())
            screenOffHandler = Handler(Looper.getMainLooper())
            killHandler = Handler(Looper.getMainLooper())
            Log.d(TAG, "Mach1: Handlers created")

            rowTextsLiveNow = ArrayList<Int>()

            // Initialize UltraliteSDK with valid context
            Log.d(TAG, "Mach1: About to initialize UltraliteSDK")
            ultraliteSdk = UltraliteSDK.get(context)
            Log.d(TAG, "Mach1: UltraliteSDK initialized")

            ultraliteListener = UltraliteListener()
            ultraliteSdk!!.addEventListener(ultraliteListener)
            Log.d(TAG, "Mach1: Event listener added")

            // Set up LiveData observers using observeForever (no LifecycleOwner needed)
            ultraliteConnectedLive = ultraliteSdk!!.getConnected()
            ultraliteControlled = ultraliteSdk!!.getControlledByMe()
            batteryStatusObserver = ultraliteSdk!!.getBatteryStatus()
            Log.d(TAG, "Mach1: LiveData references obtained")

            // Create observers
            connectedObserver = Observer { isConnected ->
                onUltraliteConnectedChange(isConnected)
            }

            controlledObserver = Observer { isControlled ->
                onUltraliteControlChanged(isControlled)
            }

            batteryObserver = Observer { batteryStatus ->
                onUltraliteBatteryChanged(batteryStatus)
            }

            // Register observers on main thread (observeForever requires main thread)
            Handler(Looper.getMainLooper()).post {
                try {
                    ultraliteConnectedLive!!.observeForever(connectedObserver!!)
                    Log.d(TAG, "Mach1: Connected observer registered")

                    ultraliteControlled!!.observeForever(controlledObserver!!)
                    Log.d(TAG, "Mach1: Controlled observer registered")

                    batteryStatusObserver!!.observeForever(batteryObserver!!)
                    Log.d(TAG, "Mach1: Battery observer registered")

                    Log.d(TAG, "Mach1: All observers registered on main thread")
                } catch (e: Exception) {
                    Log.e(TAG, "Mach1: Failed to register observers: " + e.message, e)
                }
            }

            Log.d(TAG, "Mach1 initialized with context and observers")
        } catch (e: Exception) {
            Log.e(TAG, "Mach1 constructor FAILED with exception: " + e.message, e)
            Bridge.log("Mach1 constructor FAILED: " + e.message)
        }
    }

    fun updateGlassesBrightness(brightness: Int) {
        // TODO: Implement this method
    }

    fun updateGlassesAutoBrightness(autoBrightness: Boolean) {
        // TODO: Implement this method
    }

    private fun onUltraliteConnectedChange(isConnected: Boolean) {
        Log.d(TAG, "Ultralite CONNECT changed to: " + isConnected)
        if (isConnected) {
            Log.d(TAG, "Ultralite requesting control...")
            val isControlled = ultraliteSdk!!.requestControl()
            if (isControlled) {
//                setupUltraliteCanvas();
//                changeUltraliteLayout(Layout.CANVAS);
                showHomeScreen()
            } else {
                return
            }
            Log.d(TAG, "Ultralite RESULT control request: " + isControlled)
            updateConnectionState(ConnTypes.CONNECTED)
            // connectionEvent(SmartGlassesConnectionState.CONNECTED);
        } else {
            Log.d(TAG, "Ultralite not connected.")
            updateConnectionState(ConnTypes.DISCONNECTED)
            // connectionEvent(SmartGlassesConnectionState.DISCONNECTED);
        }
    }

    private fun onUltraliteControlChanged(isControlledByMe: Boolean) {
        Log.d(TAG, "Ultralite CONTROL changed to: " + isControlledByMe)
        if (isControlledByMe) {
            hasUltraliteControl = true
            // connectionEvent(SmartGlassesConnectionState.CONNECTED);
            updateConnectionState(ConnTypes.CONNECTED)
        } else {
            hasUltraliteControl = false
        }
    }

    private fun onUltraliteBatteryChanged(batteryStatus: BatteryStatus?) {
        // Guard against null batteryStatus which can occur during connection/disconnection
        // See: MENTRA-OS-154
        if (batteryStatus == null) {
            Log.d(TAG, "Ultralite battery status is null, ignoring")
            return
        }
        Log.d(TAG, "Ultralite new battery status: " + batteryStatus.level)
        DeviceStore.apply("glasses", "batteryLevel", batteryStatus.level)

        // Match iOS: if we're already connected but weren't fully booted yet (waiting
        // for battery), now that we have battery info we can declare fully booted.
        if (connectionState == ConnTypes.CONNECTED && !fullyBooted) {
            DeviceStore.apply("glasses", "connected", true)
            DeviceStore.apply("glasses", "fullyBooted", true)
        }
    }


    protected fun setFontSizes() {
    }

    fun findCompatibleDeviceNames() {
        // EventBus.getDefault().post(new GlassesBluetoothSearchDiscoverEvent(smartGlassesDevice.deviceModelName, "NOTREQUIREDSKIP"));
        Bridge.sendDiscoveredDevice(this.type, "NOTREQUIREDSKIP")  // Use this.type to support both Mach1 and Z100
        //this.destroy();
    }

    fun connectToSmartGlasses() {
        Log.d(TAG, "connectToSmartGlasses running...")
//        int mCount = 10;
//        while ((mConnectState != 2) && (!hasUltraliteControl) && (mCount > 0)){
//            mCount--;
//            try {
//                Log.d(TAG, "Don't have Ultralite yet, let's wait for it...");
//                Thread.sleep(200);
//            } catch (InterruptedException e) {
//                e.printStackTrace();
//            }
//        }
//        Log.d(TAG, "Connected to Ultralites.");
//        Log.d(TAG, "mCOnnectestate: " + mConnectState);
//        Log.d(TAG, "mCOunt: " + mCount);
//        displayReferenceCardSimple("Connected to AugmentOS", "");
//        connectionEvent(mConnectState);
        Log.d(TAG, "connectToSmartGlasses finished")
    }

    fun displayTextLine(text: String) {
        displayReferenceCardSimple("", text)
    }

    /**
     * Display pre-wrapped text on the glasses.
     *
     * Text wrapping and processing is handled by DisplayProcessor in React Native.
     * This method is a "dumb pipe" - it just sends the text to the Vuzix SDK.
     */
    fun displayTextWall(text: String) {
        if (screenToggleOff) {
            return
        }

        goHomeHandler!!.removeCallbacksAndMessages(null)
        goHomeHandler!!.removeCallbacksAndMessages(goHomeRunnable)

        // Text is already wrapped by DisplayProcessor - just send it
        changeUltraliteLayout(Layout.TEXT_BOTTOM_LEFT_ALIGN)
        ultraliteSdk!!.sendText(text)

        if (ultraliteCanvas != null) {
            ultraliteCanvas!!.commit()
        }
        screenIsClear = false
    }

    /**
     * Display pre-composed double text wall (two columns) on the glasses.
     *
     * NOTE: DisplayProcessor now composes double_text_wall into a single text_wall
     * with pixel-precise column alignment using ColumnComposer. This method may
     * not be called anymore, but is kept for backwards compatibility.
     *
     * Column composition is handled by DisplayProcessor in React Native.
     * This method is a "dumb pipe" - it just sends the text to the Vuzix SDK.
     */
    fun displayDoubleTextWall(textTop: String, textBottom: String) {
        if (screenToggleOff) {
            return
        }

        goHomeHandler!!.removeCallbacksAndMessages(null)
        goHomeHandler!!.removeCallbacksAndMessages(goHomeRunnable)

        // Text is already composed by DisplayProcessor's ColumnComposer
        // Just combine and send - no custom logic needed
        val combinedText = textTop + "\n\n\n" + textBottom

        changeUltraliteLayout(Layout.TEXT_BOTTOM_LEFT_ALIGN)
        ultraliteSdk!!.sendText(combinedText)

        if (ultraliteCanvas != null) {
            ultraliteCanvas!!.commit()
        }
        screenIsClear = false
    }

    fun displayCustomContent(json: String) {
        displayReferenceCardSimple("CustomDisplayNotImplemented", json)
    }


    fun showNaturalLanguageCommandScreen(prompt: String, naturalLanguageInput: String) {
//        int boxDelta = 3;
//
//        if (connectedGlasses != null) {
//            connectedGlasses.clear();
//            showPromptCircle();
//
//            //show the prompt
//            lastLocNaturalLanguageArgsTextView = displayText(new TextLineSG(prompt, SMALL_FONT), new Point(0, 11), true);
//            lastLocNaturalLanguageArgsTextView = new Point(lastLocNaturalLanguageArgsTextView.x, lastLocNaturalLanguageArgsTextView.y + boxDelta); //margin down a tad
//
//            //show the final "finish command" prompt
//            int finishY = 90;
//            displayLine(new Point(0, finishY), new Point(100, finishY));
//            displayText(new TextLineSG(finishNaturalLanguageString, SMALL_FONT), new Point(0, finishY + 2), true);
//
//            //show the natural language args in a scroll box
////            ArrayList<TextLineSG> nli = new ArrayList<>();
////            nli.add(new TextLineSG(naturalLanguageInput, SMALL_FONT));
////            lastLocNaturalLanguageArgsTextView = scrollTextShow(nli, startScrollBoxY.y + boxDelta, finishY - boxDelta);
//        }
    }

    fun updateNaturalLanguageCommandScreen(naturalLanguageArgs: String) {
//        Log.d(TAG, "Displaynig: " + naturalLanguageArgs);
//        displayText(new TextLineSG(naturalLanguageArgs, SMALL_FONT), new Point(0, lastLocNaturalLanguageArgsTextView.y));
    }

    fun blankScreen() {
//        if (connectedGlasses != null){
//            connectedGlasses.clear();
//        }
    }

    fun destroy() {
        try {
            // Remove LiveData observers (using observeForever, so use removeObserver)
            if (ultraliteConnectedLive != null && connectedObserver != null) {
                ultraliteConnectedLive!!.removeObserver(connectedObserver!!)
            }
            if (ultraliteControlled != null && controlledObserver != null) {
                ultraliteControlled!!.removeObserver(controlledObserver!!)
            }
            if (batteryStatusObserver != null && batteryObserver != null) {
                batteryStatusObserver!!.removeObserver(batteryObserver!!)
            }

            if (ultraliteSdk != null) {
                // Remove event listeners and release control
                ultraliteSdk!!.removeEventListener(ultraliteListener)
                ultraliteSdk!!.releaseControl()
                ultraliteSdk = null // Nullify reference
            }

            // Cancel all pending handlers and callbacks
            if (goHomeHandler != null) {
                goHomeHandler!!.removeCallbacksAndMessages(null)
            }
            if (screenOffHandler != null) {
                screenOffHandler!!.removeCallbacksAndMessages(null)
            }
            if (killHandler != null) {
                killHandler!!.removeCallbacksAndMessages(null)
            }

            // Clear canvas and other resources
            if (ultraliteCanvas != null) {
                ultraliteCanvas!!.clear()
                ultraliteCanvas!!.commit()
                ultraliteCanvas = null
            }

            // Reset state variables
            rowTextsLiveNow!!.clear()
            screenToggleOff = false
            screenIsClear = true
            lastTapTime = 0
            totalDashboardsIdk = 0
            currentUltraliteLayout = null

            // Free up references
            this.context = null
            connectedObserver = null
            controlledObserver = null
            batteryObserver = null

            Log.d(TAG, "UltraliteSGC destroyed successfully.")
        } catch (e: Exception) {
            Log.e(TAG, "Error during destroy: ", e)
        }
    }


    fun showHomeScreen() {
        Log.d(TAG, "SHOW HOME SCREEN")
        ultraliteSdk!!.screenOff()
        screenIsClear = true
    }

    fun setupUltraliteCanvas() {
        Log.d(TAG, "Setting up ultralite canvas")
        if (ultraliteSdk != null) {
            ultraliteCanvas = ultraliteSdk!!.getCanvas()
        }
    }

    fun changeUltraliteLayout(chosenLayout: Layout) {
        //don't update layout if it's already setup
        if (currentUltraliteLayout != null && currentUltraliteLayout == chosenLayout) {
            return
        }

        ultraliteSdk!!.screenOn()

        currentUltraliteLayout = chosenLayout
        ultraliteSdk!!.setLayout(chosenLayout, 0, true, false, 2)

        if (chosenLayout == Layout.CANVAS) {
            if (ultraliteCanvas == null) {
                setupUltraliteCanvas()
            }
        }
    }

    // public void startScrollingTextViewMode(String title){
    //     super.startScrollingTextViewMode(title);

    //     if (ultraliteSdk == null) {
    //         return;
    //     }

    //     //clear the screen
    //     ultraliteCanvas.clear();
    //     drawTextOnUltralite(title);
    // }


    /**
     * Draw text on Ultralite canvas.
     * Text is expected to be pre-wrapped by DisplayProcessor.
     */
    fun drawTextOnUltralite(text: String) {
        val ultraliteColor = UltraliteColor.WHITE
        val ultraliteAnchor = Anchor.TOP_LEFT
        val ultraliteAlignment = TextAlignment.LEFT
        changeUltraliteLayout(Layout.CANVAS)
        ultraliteCanvas!!.clear()
        ultraliteCanvas!!.clearBackground(UltraliteColor.DIM)
        ultraliteCanvas!!.createText(text, ultraliteAlignment, ultraliteColor, ultraliteAnchor, true)
        ultraliteCanvas!!.commit()
        screenIsClear = false
    }

    // public Bitmap getBitmapFromDrawable(Resources res) {
        // return BitmapFactory.decodeResource(res, R.drawable.vuzix_shield);
    // }

//    public void displayReferenceCardSimple(String title, String body, int lingerTime){
//        if (!isConnected()) {
//            Log.d(TAG, "Not showing reference card because not connected to Ultralites...");
//            return;
//        }
//
////        String [] bulletPoints = {"first one", "second one", "dogs and cats"};
////        displayBulletList("Cool Bullets:", bulletPoints, 15);
//
//            Log.d(TAG, "Sending text to Ultralite SDK: \n" + body);
////            ultraliteSdk.sendText("hello world"); //this is BROKEN in Vuzix ultralite 0.4.2 SDK - crashes Vuzix OEM Platform android app
//
//        //edit the text to add new lines to it because ultralite wrapping doesn't work
////        String titleWrapped = addNewlineEveryNWords(title, 6);
////        String bodyWrapped = addNewlineEveryNWords(body, 6);
//
//        //display the title at the top of the screen
//        UltraliteColor ultraliteColor = UltraliteColor.WHITE;
//        Anchor ultraliteAnchor = Anchor.TOP_LEFT;
//        TextAlignment ultraliteAlignment = TextAlignment.LEFT;
//        changeUltraliteLayout(Layout.CANVAS);
//        ultraliteCanvas.clear();
//        ultraliteCanvas.createText(title, TextAlignment.AUTO, UltraliteColor.WHITE, Anchor.TOP_LEFT, ultraliteLeftSidePixelBuffer, 120, 640 - ultraliteLeftSidePixelBuffer, -1, TextWrapMode.WRAP, true);
//        ultraliteCanvas.createText(body, TextAlignment.AUTO, UltraliteColor.WHITE, Anchor.MIDDLE_LEFT, ultraliteLeftSidePixelBuffer, 0, 640 - ultraliteLeftSidePixelBuffer, -1, TextWrapMode.WRAP, true);
//        ultraliteCanvas.commit();
//        screenIsClear = false;
//
//        homeScreenInNSeconds(lingerTime);
//    }

    // public void setFontSize(SmartGlassesFontSize fontSize){
    //     int textSize;
    //     switch (fontSize){
    //         case SMALL:
    //             textSize = 24;
    //             maxLines = 14;
    //             maxCharsPerLine = 42;
    //             break;
    //         case MEDIUM:
    //             textSize = 29;
    //             maxLines = 12; // Adjusted from 11.5 for practical use
    //             maxCharsPerLine = 38; // Assuming max 27 characters fit per line on your display
    //             break;
    //         case LARGE:
    //             textSize = 40;
    //             maxLines = 7;
    //             maxCharsPerLine = 28;
    //             break;
    //         default:
    //             throw new IllegalArgumentException("Unknown font size: " + fontSize);
    //     }
    //     ultraliteSdk.setFont(null, 0, textSize);
    // }

    fun displayReferenceCardSimple(titleStr: String, bodyStr: String) {
        if (screenToggleOff) {
            return
        }

        val title = maybeReverseRTLString(titleStr)
        val body = maybeReverseRTLString(bodyStr)
        if (connectionState != ConnTypes.CONNECTED) {
            Log.d(TAG, "Not showing reference card because not connected to Ultralites...")
            return
        }

        changeUltraliteLayout(Layout.CANVAS)
        ultraliteCanvas!!.clear()

//        String [] bulletPoints = {"first one", "second one", "dogs and cats"};
//        displayBulletList("Cool Bullets:", bulletPoints, 15);

            Log.d(TAG, "Sending text to Ultralite SDK: \n" + body)
//            ultraliteSdk.sendText("hello world"); //this is BROKEN in Vuzix ultralite 0.4.2 SDK - crashes Vuzix OEM Platform android app

        //edit the text to add new lines to it because ultralite wrapping doesn't work
//        String titleWrapped = addNewlineEveryNWords(title, 6);
//        String bodyWrapped = addNewlineEveryNWords(body, 6);

        //display title top of scren adn text middle of screen
//        UltraliteColor ultraliteColor = UltraliteColor.WHITE;
//        Anchor ultraliteAnchor = Anchor.TOP_LEFT;
//        TextAlignment ultraliteAlignment = TextAlignment.LEFT;
//        ultraliteCanvas.createText(title, TextAlignment.AUTO, UltraliteColor.WHITE, Anchor.TOP_LEFT, ultraliteLeftSidePixelBuffer, 120, 640 - ultraliteLeftSidePixelBuffer, -1, TextWrapMode.WRAP, true);
//        ultraliteCanvas.createText(body, TextAlignment.AUTO, UltraliteColor.WHITE, Anchor.MIDDLE_LEFT, ultraliteLeftSidePixelBuffer, 0, 640 - ultraliteLeftSidePixelBuffer, -1, TextWrapMode.WRAP, true);

        //concat body and title, put text on top right of screen (to not block main view)
        val ultraliteColor = UltraliteColor.WHITE
        val ultraliteAnchor = Anchor.TOP_CENTER
        val ultraliteAlignment = TextAlignment.LEFT
        //ultraliteCanvas.createText(body, TextAlignment.AUTO, UltraliteColor.WHITE, Anchor.TOP_RIGHT, 0, 0, (640 / 2) - ultraliteLeftSidePixelBuffer, -1, TextWrapMode.WRAP, true);
        if (!title.isEmpty() && title != "") {
            ultraliteCanvas!!.createText(title + ": " + body, TextAlignment.AUTO, UltraliteColor.WHITE, Anchor.TOP_RIGHT, 0, 0, 640 / 2, -1, TextWrapMode.WRAP, true)
        } else {
            ultraliteCanvas!!.createText(body, TextAlignment.AUTO, UltraliteColor.WHITE, Anchor.TOP_RIGHT, 0, 0, 640 / 2, -1, TextWrapMode.WRAP, true)
        }

        //NOTE:
//        int createText(@NonNull
//                String text,
//                @NonNull
//                        TextAlignment alignment,
//                @NonNull
//                        UltraliteColor color,
//                @NonNull
//                        Anchor anchor,
//        int offsetX,
//        int offsetY,
//        int width,
//        int height,
//        @Nullable
//        TextWrapMode wrap,
//        boolean visible)

        ultraliteCanvas!!.commit()
        screenIsClear = false
    }


    fun displayBulletList(title: String, bullets: Array<String>) {
        displayBulletList(title, bullets, 14)
    }

    fun displayRowsCard(rowStrings: Array<String>) {
        displayRowsCard(rowStrings, cardLingerTime)
    }

    fun displayRowsCard(rowStringList: Array<String>, lingerTime: Int) {
        if (screenToggleOff) {
            return
        }

        val rowStrings = maybeReverseRTLStringList(rowStringList)
        if (connectionState != ConnTypes.CONNECTED) {
            Log.d(TAG, "Not showing rows card because not connected to Ultralites...")
            return
        }

//        changeUltraliteLayout(Layout.CANVAS);
//        ultraliteCanvas.clear();

        //make lines to draw on screen to delineate rows
        val line_thickness = 3
        var y = 120
        while (y < 480) {
            ultraliteCanvas!!.clearBackgroundRect(0, y, 640, line_thickness, UltraliteColor.DIM)
            y += 120
        }

        //clear old text
        for (i in 0 until rowTextsLiveNow!!.size) {
            ultraliteCanvas!!.removeText(i)
        }
        //old way to clear old text - vuzix ultralite sdk bug that clear background doesn't clear text?
//        for (int y = 0; y < 480; y += 120) {
//            //clear previous text
//            ultraliteCanvas.clearBackgroundRect(0, y + line_thickness, 640, 120 - line_thickness, UltraliteColor.DIM);
//            ultraliteCanvas.clearBackgroundRect(0, y + line_thickness, 640, 120 - line_thickness, UltraliteColor.BLACK);
//        }
//        ultraliteCanvas.commit();

        //display the title at the top of the screen
        val ultraliteColor = UltraliteColor.WHITE
        val ultraliteAnchor = Anchor.TOP_LEFT
        val ultraliteAlignment = TextAlignment.LEFT

        //if no input, just show the lines
        if (rowStrings.isEmpty()) {
            ultraliteCanvas!!.commit()
            screenIsClear = false
            return
        }

        //go throw rows, draw the text, don't do more than 4
        val y_start_height = 55
        // Reverse rowStrings array
        rowStrings.reverse()
        val numRows = 4
        val actualRows = Math.min(rowStrings.size, numRows)
        for (i in 0 until actualRows) {
            // Calculate the offset to start from the bottom for 1, 2, or 3 values
            val yOffset = (numRows - actualRows) * 112
            val textId = ultraliteCanvas!!.createText(rowStrings[i], TextAlignment.CENTER, UltraliteColor.WHITE, Anchor.TOP_LEFT, ultraliteLeftSidePixelBuffer, y_start_height + yOffset + (i * 112), 640 - ultraliteLeftSidePixelBuffer, -1, TextWrapMode.WRAP, true)
            rowTextsLiveNow!!.add(textId)
        }

        ultraliteCanvas!!.commit()
        screenIsClear = false
    }

    fun displayBulletList(title: String, bulletList: Array<String>, lingerTime: Int) {
        if (screenToggleOff) {
            return
        }

        val bullets = maybeReverseRTLStringList(bulletList)
        if (connectionState != ConnTypes.CONNECTED) {
            Log.d(TAG, "Not showing bullet point list because not connected to Ultralites...")
            return
        }

        Log.d(TAG, "Sending bullets to Ultralite SDK: " + title)

        //display the title at the top of the screen
        val ultraliteColor = UltraliteColor.WHITE
        val ultraliteAnchor = Anchor.TOP_LEFT
        val ultraliteAlignment = TextAlignment.LEFT
        changeUltraliteLayout(Layout.CANVAS)
        ultraliteCanvas!!.clear()

        ultraliteCanvas!!.createText(title, TextAlignment.AUTO, UltraliteColor.WHITE, Anchor.TOP_LEFT, 0, 0, 640, -1, TextWrapMode.WRAP, true)
        var displaceY = 25
        val displaceX = 25
        for (bullet in bullets) {
            ultraliteCanvas!!.createText("⬤ " + bullet, TextAlignment.AUTO, UltraliteColor.WHITE, Anchor.TOP_LEFT, displaceX, displaceY, 640 - displaceX, -1, TextWrapMode.WRAP, true)
            displaceY += 125
        }

        ultraliteCanvas!!.commit()
        screenIsClear = false
    }

//    public void homeScreenInNSeconds(int n){
//        if (n == -1){
//            return;
//        }
//
//       //disconnect after slight delay, so our above text gets a chance to show up
//       goHomeHandler.removeCallbacksAndMessages(null);
//       goHomeHandler.removeCallbacksAndMessages(goHomeRunnable);
//       goHomeRunnable = new Runnable() {
//           @Override
//           public void run() {
//               showHomeScreen();
//        }};
//       goHomeHandler.postDelayed(goHomeRunnable, n * 1000);
//    }

    fun displayBitmap(bmp: Bitmap) {
        val resizedBmp = Bitmap.createScaledBitmap(bmp, 620, 460, true) // 640 x 480

        changeUltraliteLayout(Layout.CANVAS)
        screenIsClear = false

        Log.d(TAG, "Sending bitmap to Ultralite")
        ultraliteCanvas!!.drawBackground(resizedBmp, 50, 80)
        ultraliteCanvas!!.commit()
    }

    //don't show images on activelook (screen is too low res)
    fun displayReferenceCardImage(title: String, body: String, imgUrl: String) {
        if (screenToggleOff) {
            return
        }

        changeUltraliteLayout(Layout.CANVAS)
        ultraliteCanvas!!.clear()

        //make image
        //below works, but only for very, very low res/size images
        val ultraliteImageAnchor = Anchor.CENTER
        Picasso.get()
                .load(imgUrl)
                .into(object : Target {
                    override fun onBitmapLoaded(bitmap: Bitmap?, from: Picasso.LoadedFrom?) {
                        // Use the bitmap
//                        LVGLImage ultraliteImage = LVGLImage.fromBitmap(getBitmapFromDrawable(context.getResources()), CF_INDEXED_2_BIT);
//                        LVGLImage ultraliteImage = LVGLImage.fromBitmap(bitmap, CF_INDEXED_2_BIT);
                        changeUltraliteLayout(Layout.CANVAS)

                        //send text first, cuz this is fast
                        ultraliteCanvas!!.createText(title, TextAlignment.AUTO, UltraliteColor.WHITE, Anchor.TOP_LEFT, 0, 0, 640, -1, TextWrapMode.WRAP, true)
                        ultraliteCanvas!!.createText(body, TextAlignment.AUTO, UltraliteColor.WHITE, Anchor.BOTTOM_LEFT, 0, 0, 640, -1, TextWrapMode.WRAP, true)
                        ultraliteCanvas!!.commit()
                        screenIsClear = false

                        Log.d(TAG, "Sending image to Ultralite")
//                        ultraliteCanvas.createImage(ultraliteImage, ultraliteImageAnchor, 0, 0, true);
                        ultraliteCanvas!!.drawBackground(bitmap!!, 0, 0)

                        //sending text again to ultralite in case image overwrote it
//                        ultraliteCanvas.createText(title + "2", TextAlignment.AUTO, UltraliteColor.WHITE, Anchor.BOTTOM_LEFT, 0, 0, 640, -1, TextWrapMode.WRAP, true);
//                        ultraliteCanvas.createText(body + "2", TextAlignment.AUTO, UltraliteColor.WHITE, Anchor.MIDDLE_LEFT, 0, 0, 640, -1, TextWrapMode.WRAP, true);
//                        ultraliteCanvas.commit();

//                        //display the title at the top of the screen
//                        UltraliteColor ultraliteColor = UltraliteColor.WHITE;
//                        TextAlignment ultraliteAlignment = TextAlignment.LEFT;
//                //        ultraliteCanvas.clearBackground(UltraliteColor.DIM);
//                        ultraliteCanvas.createText(titleWrapped, ultraliteAlignment, ultraliteColor, Anchor.TOP_LEFT, true); //, 0, 0, -1, -1, TextWrapMode.WRAP, true);
//                        ultraliteCanvas.createText(bodyWrapped, ultraliteAlignment, ultraliteColor, Anchor.BOTTOM_LEFT, true); //, 0, 0, -1, -1, TextWrapMode.WRAP, true);
//                        ultraliteCanvas.commit();
                    }

                    override fun onBitmapFailed(e: Exception?, errorDrawable: Drawable?) {
                        // Handle the error
                        Log.d(TAG, "Bitmap failed")
                        e!!.printStackTrace()
                    }

                    override fun onPrepareLoad(placeHolderDrawable: Drawable?) {
                        // Called before the image is loaded. You can set a placeholder if needed.
                    }
                })

            //edit the text to add new lines to it because ultralite wrapping doesn't work
//            String titleWrapped = addNewlineEveryNWords(title, 6);
//            String bodyWrapped = addNewlineEveryNWords(body, 6);
//
//            //display the title at the top of the screen
//            UltraliteColor ultraliteColor = UltraliteColor.WHITE;
//            TextAlignment ultraliteAlignment = TextAlignment.LEFT;
//            //ultraliteCanvas.clearBackground(UltraliteColor.DIM);
//            ultraliteCanvas.createText(titleWrapped, ultraliteAlignment, ultraliteColor, Anchor.TOP_LEFT, true); //, 0, 0, -1, -1, TextWrapMode.WRAP, true);
//            ultraliteCanvas.createText(bodyWrapped, ultraliteAlignment, ultraliteColor, Anchor.BOTTOM_LEFT, true); //, 0, 0, -1, -1, TextWrapMode.WRAP, true);
//            ultraliteCanvas.commit();
//            screenIsClear = false;
    }

    //handles text wrapping, returns final position of last line printed
//    private Point displayText(TextLineSG textLine, Point percentLoc, boolean centered){
//        if (!isConnected()){
//            return null;
//        }
//
//        //get info about the wrapping
//        Pair wrapInfo = computeStringWrapInfo(textLine);
//        int numWraps = (int)wrapInfo.first;
//        int wrapLenNumChars = (int)wrapInfo.second;
//
//        //loop through the text, writing out individual lines to the glasses
//        ArrayList<String> chunkedText = new ArrayList<>();
//        Point textPoint = percentLoc;
//        int textMarginY = computeMarginPercent(textLine.getFontSizeCode()); //(fontToSize.get(textLine.getFontSize()) * 1.3)
//        for (int i = 0; i <= numWraps; i++){
//            int startIdx = wrapLenNumChars * i;
//            int endIdx = Math.min(startIdx + wrapLenNumChars, textLine.getText().length());
//            String subText = textLine.getText().substring(startIdx, endIdx).trim();
//            chunkedText.add(subText);
//            TextLineSG thisTextLine = new TextLineSG(subText, textLine.getFontSizeCode());
//            if (!centered) {
//                sendTextToGlasses(thisTextLine, textPoint);
//            } else {
//                int xPercentLoc = computeStringCenterInfo(thisTextLine);
//                sendTextToGlasses(thisTextLine, new Point(xPercentLoc, textPoint.y));
//            }
//            textPoint = new Point(textPoint.x, textPoint.y + pixelToPercent(displayHeightPixels, fontToSize.get(textLine.getFontSizeCode())) + textMarginY); //lower our text for the next loop
//        }
//
//        return textPoint;
//    }

    fun stopScrollingTextViewMode() {
//        if (connectedGlasses == null) {
//            return;
//        }
//
//        //clear the screen
//        connectedGlasses.clear();
    }

    fun scrollingTextViewIntermediateText(text: String) {
    }

    fun scrollingTextViewFinalText(text: String) {
        if (connectionState != ConnTypes.CONNECTED) {
            return
        }

//        //save to our saved list of final scrolling text strings
//        finalScrollingTextStrings.add(text);
//
//        //get the max number of wraps allows
//        float allowedTextRows = computeAllowedTextRows(fontToSize.get(scrollingTextTitleFontSize), fontToSize.get(scrollingTextTextFontSize), percentToPixel(displayHeightPixels, computeMarginPercent(scrollingTextTextFontSize)));
//
//        //figure out the maximum we can display
//        int totalRows = 0;
//        ArrayList<String> finalTextToDisplay = new ArrayList<>();
//        boolean hitBottom = false;
//        for (int i = finalScrollingTextStrings.toArray().length - 1; i >= 0; i--){
//            String finalText = finalScrollingTextStrings.get(i);
//            //convert to a TextLine type with small font
//            TextLineSG tlString = new TextLineSG(finalText, SMALL_FONT);
//            //get info about the wrapping of this string
//            Pair wrapInfo = computeStringWrapInfo(tlString);
//            int numWraps = (int)wrapInfo.first;
//            int wrapLenNumChars = (int)wrapInfo.second;
//            totalRows += numWraps + 1;
//
//            if (totalRows > allowedTextRows){
//                finalScrollingTextStrings = finalTextToDisplay;
//                lastLocScrollingTextView = belowTitleLocScrollingTextView;
//                //clear the glasses as we hit our limit and need to redraw
//                connectedGlasses.color((byte)0x00);
//                connectedGlasses.rectf(percentScreenToPixelsLocation(belowTitleLocScrollingTextView.x, belowTitleLocScrollingTextView.y), percentScreenToPixelsLocation(100, 100));
//                //stop looping, as we've ran out of room
//                hitBottom = true;
//            } else {
//                finalTextToDisplay.add(0, finalText);
//            }
//        }
//
//        //display all of the text that we can
//        if (hitBottom) { //if we ran out of room, we need to redraw all the text
//            for (String finalString : finalTextToDisplay) {
//                TextLineSG tlString = new TextLineSG(finalString, scrollingTextTextFontSize);
//                //write this text at the last location + margin
//                Log.d(TAG, "Writing string: " + tlString.getText() + finalTextToDisplay.size());
//                lastLocScrollingTextView = displayText(tlString, new Point(0, lastLocScrollingTextView.y));
//            }
//        } else { //if we didn't hit the bottom, and there's room, we can just display the next line
//            TextLineSG tlString = new TextLineSG(text, scrollingTextTextFontSize);
//            lastLocScrollingTextView = displayText(tlString, new Point(0, lastLocScrollingTextView.y));
//        }

    }

    fun maybeReverseRTLStringList(input: Array<String>): Array<String> {
        val out = arrayOfNulls<String>(input.size)
        for (i in 0 until input.size)
            out[i] = maybeReverseRTLString(input[i])
        @Suppress("UNCHECKED_CAST")
        return out as Array<String>
    }

    fun displayPromptView(prompt: String, options: Array<String>?) {
        if (connectionState != ConnTypes.CONNECTED) {
            return
        }

//        ultraliteCanvas.clear();
//        connectedGlasses.clear();
//        showPromptCircle();
//
//        //show the prompt and options, if any
//        ArrayList<Object> promptPageElements = new ArrayList<>();
//        promptPageElements.add(new TextLineSG(prompt, LARGE_FONT));
//        if (options != null) {
//            //make an array list of options
//            for (String s : options){
//               promptPageElements.add(new TextLineSG(s, SMALL_FONT));
//            }
//        }
//        displayLinearStuff(promptPageElements, new Point(0, 11), true);
    }

}
