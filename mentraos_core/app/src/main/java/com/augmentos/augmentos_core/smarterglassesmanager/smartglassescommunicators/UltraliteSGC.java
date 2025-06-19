package com.augmentos.augmentos_core.smarterglassesmanager.smartglassescommunicators;

import android.content.Context;
import android.content.res.Resources;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.drawable.Drawable;
import android.os.Handler;
import android.util.Log;

import androidx.lifecycle.LifecycleOwner;
import androidx.lifecycle.LiveData;

import com.augmentos.augmentos_core.R;
import com.augmentos.augmentos_core.smarterglassesmanager.smartglassescommunicators.SmartGlassesCommunicator;
import com.augmentos.augmentos_core.smarterglassesmanager.smartglassescommunicators.SmartGlassesFontSize;
import com.augmentos.augmentos_core.smarterglassesmanager.utils.SmartGlassesConnectionState;
import com.squareup.picasso.Picasso;
import com.squareup.picasso.Target;
import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.BatteryLevelEvent;
import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.GlassesBluetoothSearchDiscoverEvent;
import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.GlassesDisplayPowerEvent;
import com.augmentos.augmentos_core.smarterglassesmanager.supportedglasses.SmartGlassesDevice;
import com.vuzix.ultralite.Anchor;
import com.vuzix.ultralite.BatteryStatus;
import com.vuzix.ultralite.EventListener;
import com.vuzix.ultralite.Layout;
import com.vuzix.ultralite.TextAlignment;
import com.vuzix.ultralite.TextWrapMode;
import com.vuzix.ultralite.UltraliteColor;
import com.vuzix.ultralite.UltraliteSDK;

import org.greenrobot.eventbus.EventBus;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;


//communicate with ActiveLook smart glasses
public class UltraliteSGC extends SmartGlassesCommunicator {
    private static final String TAG = "WearableAi_UltraliteSGC";

    UltraliteSDK ultraliteSdk;
    UltraliteSDK.Canvas ultraliteCanvas;
    UltraliteListener ultraliteListener;
    Layout currentUltraliteLayout;
    boolean screenToggleOff = false; //should we keep the screen off?
    LifecycleOwner lifecycleOwner;
    Context context;
    public static final int cardLingerTime = 15;

    private ArrayList rowTextsLiveNow;

    //ultralite pixel buffer on left side of screen
    int ultraliteLeftSidePixelBuffer = 40;

    // Constants for maximum lines and characters per line //depends on size of pixel buffer! //for MEDIUM text!
    private int maxLines = 12; // Adjusted from 11.5 for practical use
    private int maxCharsPerLine = 38; // Assuming max 27 characters fit per line on your display

    //handler to turn off screen
    Handler goHomeHandler;
    Runnable goHomeRunnable;

    //handler to turn off screen/toggle
    Handler screenOffHandler;
    Runnable screenOffRunnable;

    //handler to check battery life
    Handler batteryHandler;
    Runnable batteryRunnable;

    //handler to disconnect
    Handler killHandler;

    boolean hasUltraliteControl;
    boolean screenIsClear;
    SmartGlassesDevice smartGlassesDevice;
    private static final long TAP_DEBOUNCE_TIME = 80; // milliseconds
    private long lastTapTime = 0;
    private int totalDashboardsIdk = 0;

    public class UltraliteListener implements EventListener{
        @Override
        public void onTap(int tapCount) {
            long currentTime = System.currentTimeMillis();
            if (currentTime - lastTapTime < TAP_DEBOUNCE_TIME) {
                Log.d(TAG, "Ignoring duplicate tap event");
                return;
            }
            totalDashboardsIdk++;
            Log.d(TAG, "TOTAL NUMBER OF DASHBOARD TOGGLEZ: " + totalDashboardsIdk);

            lastTapTime = currentTime;
            Log.d(TAG, "Ultralite go tap n times: " + tapCount);
            tapEvent(tapCount);
        }

        @Override
        public void onDisplayTimeout() {
            Log.d(TAG, "Ultralite display timeout.");
        }

        @Override
        public void onPowerButtonPress(boolean turningOn) {
            //since we implement our own state for the power turn on/off, we ignore what the ultralite thinks ('turningOn') and use our own state
            Log.d(TAG, "Ultralites power button pressed: " + turningOn);

            //flip value of screen toggle
            screenToggleOff = !screenToggleOff;

            if (!screenToggleOff) {
                Log.d(TAG, "screen toggle off NOT on, showing turn ON message");
                EventBus.getDefault().post(new GlassesDisplayPowerEvent(screenToggleOff));
            } else {
                Log.d(TAG, "screen toggle off IS on");
            }
        }
    }
    private LiveData<Boolean> ultraliteConnectedLive;
    private LiveData<Boolean> ultraliteControlled;
    private LiveData<BatteryStatus> batteryStatusObserver;

    public UltraliteSGC(Context context, SmartGlassesDevice smartGlassesDevice, LifecycleOwner lifecycleOwner) {
        super();
        this.lifecycleOwner = lifecycleOwner;
        this.context = context;

        mConnectState = SmartGlassesConnectionState.DISCONNECTED;
        hasUltraliteControl = false;
        screenIsClear = true;
        goHomeHandler = new Handler();
        screenOffHandler = new Handler();
        killHandler = new Handler();

        rowTextsLiveNow = new ArrayList<Integer>();
        this.smartGlassesDevice = smartGlassesDevice;

        ultraliteSdk = UltraliteSDK.get(context);
        ultraliteListener = new UltraliteListener();
        ultraliteSdk.addEventListener(ultraliteListener);

        // Only observe LiveData if we have a valid lifecycleOwner
        if (lifecycleOwner != null) {
            ultraliteConnectedLive = ultraliteSdk.getConnected();
            ultraliteConnectedLive.observe(lifecycleOwner, isConnected -> {
                onUltraliteConnectedChange(isConnected);
            });

            ultraliteControlled = ultraliteSdk.getControlledByMe();
            ultraliteControlled.observe(lifecycleOwner, isControlled -> {
                onUltraliteControlChanged(isControlled);
            });

            //setup battery status
            EventBus.getDefault().post(new BatteryLevelEvent(ultraliteSdk.getBatteryLevel(), false));
            batteryStatusObserver = ultraliteSdk.getBatteryStatus();
            batteryStatusObserver.observe(lifecycleOwner, batteryStatus -> {
                onUltraliteBatteryChanged(batteryStatus);
            });
        } else {
            Log.w(TAG, "No LifecycleOwner provided, LiveData observation is disabled");
            ultraliteConnectedLive = ultraliteSdk.getConnected();
            ultraliteControlled = ultraliteSdk.getControlledByMe();
            batteryStatusObserver = ultraliteSdk.getBatteryStatus();
            
            // Still send the initial battery level
            EventBus.getDefault().post(new BatteryLevelEvent(ultraliteSdk.getBatteryLevel(), false));
            
            // Note: We don't need polling anymore since we'll be using LifecycleService
        }

//        if (ultraliteSdk.isAvailable()){
//            Log.d(TAG, "Ultralite SDK is available.");
//        } else {
//            Log.d(TAG, "Ultralite SDK is NOT available.");
//        }
    }

    @Override
    public void updateGlassesBrightness(int brightness) {
        // TODO: Implement this method
    }

    @Override
    public void updateGlassesAutoBrightness(boolean autoBrightness) {
        // TODO: Implement this method
    }

    private void onUltraliteConnectedChange(boolean isConnected) {
        Log.d(TAG, "Ultralite CONNECT changed to: " + isConnected);
        if (isConnected) {
            Log.d(TAG, "Ultralite requesting control...");
            boolean isControlled = ultraliteSdk.requestControl();
            if (isControlled){
//                setupUltraliteCanvas();
//                changeUltraliteLayout(Layout.CANVAS);
                showHomeScreen();
            } else {
                return;
            }
            Log.d(TAG, "Ultralite RESULT control request: " + isControlled);
            connectionEvent(SmartGlassesConnectionState.CONNECTED);
        } else {
            Log.d(TAG, "Ultralite not connected.");
            connectionEvent(SmartGlassesConnectionState.DISCONNECTED);
        }
    }

    private void onUltraliteControlChanged(boolean isControlledByMe) {
        Log.d(TAG, "Ultralite CONTROL changed to: " + isControlledByMe);
        if(isControlledByMe) {
            hasUltraliteControl = true;
            connectionEvent(SmartGlassesConnectionState.CONNECTED);
        } else {
            hasUltraliteControl = false;
        }
    }

    private void onUltraliteBatteryChanged(BatteryStatus batteryStatus) {
        Log.d(TAG, "Ultralite new battery status");
        int batteryLevel = batteryStatus.getLevel();
        EventBus.getDefault().post(new BatteryLevelEvent(batteryLevel, false));
    }


    @Override
    protected void setFontSizes(){
    }

    @Override
    public void findCompatibleDeviceNames() {
        EventBus.getDefault().post(new GlassesBluetoothSearchDiscoverEvent(smartGlassesDevice.deviceModelName, "NOTREQUIREDSKIP"));
        //this.destroy();
    }

    @Override
    public void connectToSmartGlasses(){
        Log.d(TAG, "connectToSmartGlasses running...");
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
        Log.d(TAG, "connectToSmartGlasses finished");
    }

    public void displayTextLine(String text){
        displayReferenceCardSimple("", text);
    }

    private static final int MAX_LINES = 7;
    public void displayTextWall(String text) {
        String cleanedText = cleanText(text);

        if (screenToggleOff) {
            return;
        }

        goHomeHandler.removeCallbacksAndMessages(null);
        goHomeHandler.removeCallbacksAndMessages(goHomeRunnable);

//        Log.d(TAG, "Ultralite is doing text wall");

        // Cut text wall down to the largest number of lines possible to display
        String[] lines = cleanedText.split("\n");
        StringBuilder truncatedText = new StringBuilder();
        for (int i = 0; i < Math.min(lines.length, MAX_LINES); i++) {
            truncatedText.append(lines[i]).append("\n");
        }

//        changeUltraliteLayout(Layout.TEXT_BOTTOM_LEFT_ALIGN);
        changeUltraliteLayout(Layout.TEXT_BOTTOM_LEFT_ALIGN);
        ultraliteSdk.sendText(truncatedText.toString().trim());

//        changeUltraliteLayout(Layout.CANVAS);
//        ultraliteCanvas.removeText(0); //remove last text we added
//        Anchor ultraliteAnchor = Anchor.TOP_LEFT;
//        TextAlignment ultraliteAlignment = TextAlignment.LEFT;
//        int textId = ultraliteCanvas.createText(text, ultraliteAlignment, UltraliteColor.WHITE, ultraliteAnchor, ultraliteLeftSidePixelBuffer, 0, 640 - ultraliteLeftSidePixelBuffer, -1, TextWrapMode.WRAP, true);
////        ultraliteCanvas.createText(title, TextAlignment.AUTO, UltraliteColor.WHITE, Anchor.TOP_LEFT, ultraliteLeftSidePixelBuffer, 120, 640 - ultraliteLeftSidePixelBuffer, -1, TextWrapMode.WRAP, true);
//        Log.d(TAG, "VUZIX TEXT ID: " + textId);

        if (ultraliteCanvas != null) {
            ultraliteCanvas.commit();
        }
        screenIsClear = false;
    }

    private String cleanText(String input) {
        // Replace Chinese punctuation with English equivalents
        String cleaned = input.replace(" ，", ", ")
                .replace("，", ", ")
                .replace(" 。", ".")
                .replace("。", ".")
                .replace(" ！", "!")
                .replace(" ？", "?")
                .replace("？", "?")
                .replace("：", ":")
                .replace("；", ";")
                .replace("（", "(")
                .replace("）", ")")
                .replace("【", "[")
                .replace("】", "]")
                .replace("“", "\"")
                .replace("”", "\"")
                .replace("、", ",") // No quotes around this one
                .replace("‘", "'")
                .replace("’", "'");

        // Fix contractions: handle spaces around apostrophes
        cleaned = cleaned.replaceAll("\\s+'\\s*", "'");

        // Remove any non-breaking spaces and trim leading/trailing spaces
//        cleaned = cleaned.replace("\u00A0", " ").trim();

        return cleaned;
    }

    public static int countNewLines(String str) {
        int count = 0;
        for (int i = 0; i < str.length(); i++) {
            if (str.charAt(i) == '\n') {
                count++;
            }
        }
        return count;
    }

    public void displayDoubleTextWall(String textTop, String textBottom) {
        if (screenToggleOff) {
            return;
        }

        textTop = cleanText(textTop);
        textBottom = cleanText(textBottom);

//        if (textBottom.endsWith("\n")) {
//            textBottom = textBottom.substring(0, textBottom.length() - 1);
//        }

        goHomeHandler.removeCallbacksAndMessages(null);
        goHomeHandler.removeCallbacksAndMessages(goHomeRunnable);

//        int rowsTop = 5;
        int rowsTop = 3 - countNewLines(textTop);

        StringBuilder combinedText = new StringBuilder();
        combinedText.append(textTop);

        for (int i = 0; i < rowsTop; i++) {
            combinedText.append("\n");
        }

        StringBuilder bottomBuilder = new StringBuilder(textBottom);

        combinedText.append(bottomBuilder);

        // Display the combined text using TEXT_BOTTOM_LEFT_ALIGN layout
        changeUltraliteLayout(Layout.TEXT_BOTTOM_LEFT_ALIGN);
        // ultraliteSdk.sendText(combinedText.toString().trim());
        ultraliteSdk.sendText(combinedText.toString());
        if (ultraliteCanvas != null) {
            ultraliteCanvas = ultraliteSdk.getCanvas();
        }
        if (ultraliteCanvas != null) {
            ultraliteCanvas.commit();
        }

        screenIsClear = false;
    }

    public void displayCustomContent(String json) {
        displayReferenceCardSimple("CustomDisplayNotImplemented", json);
    }


    public void showNaturalLanguageCommandScreen(String prompt, String naturalLanguageInput){
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

    public void updateNaturalLanguageCommandScreen(String naturalLanguageArgs){
//        Log.d(TAG, "Displaynig: " + naturalLanguageArgs);
//        displayText(new TextLineSG(naturalLanguageArgs, SMALL_FONT), new Point(0, lastLocNaturalLanguageArgsTextView.y));
    }

    public void blankScreen(){
//        if (connectedGlasses != null){
//            connectedGlasses.clear();
//        }
    }

    @Override
    public void destroy() {
        try {
            if (ultraliteSdk != null) {
                // Remove LiveData observers only if lifecycleOwner is not null
                if (lifecycleOwner != null) {
                    ultraliteConnectedLive.removeObservers(lifecycleOwner);
                    ultraliteControlled.removeObservers(lifecycleOwner);
                    batteryStatusObserver.removeObservers(lifecycleOwner);
                }

                // Remove event listeners and release control
                ultraliteSdk.removeEventListener(ultraliteListener);
                ultraliteSdk.releaseControl();
                ultraliteSdk = null; // Nullify reference
            }

            // Cancel all pending handlers and callbacks
            if (goHomeHandler != null) {
                goHomeHandler.removeCallbacksAndMessages(null);
            }
            if (screenOffHandler != null) {
                screenOffHandler.removeCallbacksAndMessages(null);
            }
            // Removed battery polling handler cleanup as we're no longer using it
            if (killHandler != null) {
                killHandler.removeCallbacksAndMessages(null);
            }

            // Clear canvas and other resources
            if (ultraliteCanvas != null) {
                ultraliteCanvas.clear();
                ultraliteCanvas.commit();
                ultraliteCanvas = null;
            }

            // Reset state variables
            rowTextsLiveNow.clear();
            screenToggleOff = false;
            screenIsClear = true;
            lastTapTime = 0;
            totalDashboardsIdk = 0;
            currentUltraliteLayout = null;

            // Free up references
            this.context = null;
            this.lifecycleOwner = null;

            Log.d(TAG, "UltraliteSGC destroyed successfully.");
        } catch (Exception e) {
            Log.e(TAG, "Error during destroy: ", e);
        }
    }


    public void showHomeScreen() {
        Log.d(TAG, "SHOW HOME SCREEN");
        ultraliteSdk.screenOff();
        screenIsClear = true;
    }

    public void setupUltraliteCanvas(){
        Log.d(TAG, "Setting up ultralite canvas");
        if (ultraliteSdk != null) {
            ultraliteCanvas = ultraliteSdk.getCanvas();
        }
    }

    public void changeUltraliteLayout(Layout chosenLayout) {
        //don't update layout if it's already setup
        if (currentUltraliteLayout != null && currentUltraliteLayout == chosenLayout){
            return;
        }

        ultraliteSdk.screenOn();

        currentUltraliteLayout = chosenLayout;
        ultraliteSdk.setLayout(chosenLayout, 0, true, false, 2);

        if (chosenLayout.equals(Layout.CANVAS)){
            if (ultraliteCanvas == null){
                setupUltraliteCanvas();
            }
        }
    }

    public void startScrollingTextViewMode(String title){
        super.startScrollingTextViewMode(title);

        if (ultraliteSdk == null) {
            return;
        }

        //clear the screen
        ultraliteCanvas.clear();
        drawTextOnUltralite(title);
    }

    public String addNewlineEveryNWords(String input, int n) {
        String[] words = input.split("\\s+");
        StringBuilder result = new StringBuilder();

        for (int i = 0; i < words.length; i++) {
            result.append(words[i]);
            if ((i + 1) % n == 0 && i != words.length - 1) {
                result.append("\n");
            } else if (i != words.length - 1) {
                result.append(" ");
            }
        }

        return result.toString();
    }

    public void drawTextOnUltralite(String text){
        //edit the text to add new lines to it because ultralite wrapping doesn't work
        String wrappedText = addNewlineEveryNWords(text, 6);

        //display the title at the top of the screen
        UltraliteColor ultraliteColor = UltraliteColor.WHITE;
        Anchor ultraliteAnchor = Anchor.TOP_LEFT;
        TextAlignment ultraliteAlignment = TextAlignment.LEFT;
        changeUltraliteLayout(Layout.CANVAS);
        ultraliteCanvas.clear();
        ultraliteCanvas.clearBackground(UltraliteColor.DIM);
//        ultraliteCanvas.createText(text, ultraliteAlignment, ultraliteColor, ultraliteAnchor, true);
//        ultraliteCanvas.createText(text, ultraliteAlignment, ultraliteColor, Anchor.BOTTOM_LEFT, 0, 0, -1, 80, TextWrapMode.WRAP, true);
        ultraliteCanvas.createText(wrappedText, ultraliteAlignment, ultraliteColor, ultraliteAnchor, true); //, 0, 0, -1, -1, TextWrapMode.WRAP, true);
        ultraliteCanvas.commit();
        screenIsClear = false;
    }

    public Bitmap getBitmapFromDrawable(Resources res) {
        return BitmapFactory.decodeResource(res, R.drawable.vuzix_shield);
    }

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

    public void setFontSize(SmartGlassesFontSize fontSize){
        int textSize;
        switch (fontSize){
            case SMALL:
                textSize = 24;
                maxLines = 14;
                maxCharsPerLine = 42;
                break;
            case MEDIUM:
                textSize = 29;
                maxLines = 12; // Adjusted from 11.5 for practical use
                maxCharsPerLine = 38; // Assuming max 27 characters fit per line on your display
                break;
            case LARGE:
                textSize = 40;
                maxLines = 7;
                maxCharsPerLine = 28;
                break;
            default:
                throw new IllegalArgumentException("Unknown font size: " + fontSize);
        }
        ultraliteSdk.setFont(null, 0, textSize);
    }

    public void displayReferenceCardSimple(String titleStr, String bodyStr){
        if (screenToggleOff){
            return;
        }

        String title = maybeReverseRTLString(titleStr);
        String body = maybeReverseRTLString(bodyStr);
        if (!isConnected()) {
            Log.d(TAG, "Not showing reference card because not connected to Ultralites...");
            return;
        }

        changeUltraliteLayout(Layout.CANVAS);
        ultraliteCanvas.clear();

//        String [] bulletPoints = {"first one", "second one", "dogs and cats"};
//        displayBulletList("Cool Bullets:", bulletPoints, 15);

            Log.d(TAG, "Sending text to Ultralite SDK: \n" + body);
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
        UltraliteColor ultraliteColor = UltraliteColor.WHITE;
        Anchor ultraliteAnchor = Anchor.TOP_CENTER;
        TextAlignment ultraliteAlignment = TextAlignment.LEFT;
        //ultraliteCanvas.createText(body, TextAlignment.AUTO, UltraliteColor.WHITE, Anchor.TOP_RIGHT, 0, 0, (640 / 2) - ultraliteLeftSidePixelBuffer, -1, TextWrapMode.WRAP, true);
        if (!title.isEmpty() && !title.equals("")){
            ultraliteCanvas.createText(title + ": " + body, TextAlignment.AUTO, UltraliteColor.WHITE, Anchor.TOP_RIGHT, 0, 0, 640 / 2, -1, TextWrapMode.WRAP, true);
        } else {
            ultraliteCanvas.createText(body, TextAlignment.AUTO, UltraliteColor.WHITE, Anchor.TOP_RIGHT, 0, 0, 640 / 2, -1, TextWrapMode.WRAP, true);
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

        ultraliteCanvas.commit();
        screenIsClear = false;
    }


    public void displayBulletList(String title, String [] bullets){
        displayBulletList(title, bullets, 14);
    }

    public void displayRowsCard(String[] rowStrings){
        displayRowsCard(rowStrings, cardLingerTime);
    }

    public void displayRowsCard(String[] rowStringList, int lingerTime){
        if (screenToggleOff){
            return;
        }

        String[] rowStrings = maybeReverseRTLStringList(rowStringList);
        if (!isConnected()) {
            Log.d(TAG, "Not showing rows card because not connected to Ultralites...");
            return;
        }

//        changeUltraliteLayout(Layout.CANVAS);
//        ultraliteCanvas.clear();

        //make lines to draw on screen to delineate rows
        int line_thickness = 3;
        for (int y = 120; y < 480; y += 120) {
            ultraliteCanvas.clearBackgroundRect(0, y, 640, line_thickness, UltraliteColor.DIM);
        }

        //clear old text
        for (int i = 0; i < rowTextsLiveNow.size(); i++){
            ultraliteCanvas.removeText(i);
        }
        //old way to clear old text - vuzix ultralite sdk bug that clear background doesn't clear text?
//        for (int y = 0; y < 480; y += 120) {
//            //clear previous text
//            ultraliteCanvas.clearBackgroundRect(0, y + line_thickness, 640, 120 - line_thickness, UltraliteColor.DIM);
//            ultraliteCanvas.clearBackgroundRect(0, y + line_thickness, 640, 120 - line_thickness, UltraliteColor.BLACK);
//        }
//        ultraliteCanvas.commit();

        //display the title at the top of the screen
        UltraliteColor ultraliteColor = UltraliteColor.WHITE;
        Anchor ultraliteAnchor = Anchor.TOP_LEFT;
        TextAlignment ultraliteAlignment = TextAlignment.LEFT;

        //if no input, just show the lines
        if (rowStrings.length == 0){
            ultraliteCanvas.commit();
            screenIsClear = false;
            return;
        }

        //go throw rows, draw the text, don't do more than 4
        int y_start_height = 55;
        // Reverse rowStrings array
        Collections.reverse(Arrays.asList(rowStrings));
        int numRows = 4;
        int actualRows = Math.min(rowStrings.length, numRows);
        for (int i = 0; i < actualRows; i++) {
            // Calculate the offset to start from the bottom for 1, 2, or 3 values
            int yOffset = (numRows - actualRows) * 112;
            int textId = ultraliteCanvas.createText(rowStrings[i], TextAlignment.CENTER, UltraliteColor.WHITE, Anchor.TOP_LEFT, ultraliteLeftSidePixelBuffer, y_start_height + yOffset + (i * 112), 640 - ultraliteLeftSidePixelBuffer, -1, TextWrapMode.WRAP, true);
            rowTextsLiveNow.add(textId);
        }

        ultraliteCanvas.commit();
        screenIsClear = false;
    }

    public void displayBulletList(String title, String [] bulletList, int lingerTime){
        if (screenToggleOff){
            return;
        }

        String[] bullets = maybeReverseRTLStringList(bulletList);
        if (!isConnected()) {
            Log.d(TAG, "Not showing bullet point list because not connected to Ultralites...");
            return;
        }

        Log.d(TAG, "Sending bullets to Ultralite SDK: " + title);

        //display the title at the top of the screen
        UltraliteColor ultraliteColor = UltraliteColor.WHITE;
        Anchor ultraliteAnchor = Anchor.TOP_LEFT;
        TextAlignment ultraliteAlignment = TextAlignment.LEFT;
        changeUltraliteLayout(Layout.CANVAS);
        ultraliteCanvas.clear();

        ultraliteCanvas.createText(title, TextAlignment.AUTO, UltraliteColor.WHITE, Anchor.TOP_LEFT, 0, 0, 640, -1, TextWrapMode.WRAP, true);
        int displaceY = 25;
        int displaceX = 25;
        for (String bullet : bullets){
            ultraliteCanvas.createText("⬤ " + bullet, TextAlignment.AUTO, UltraliteColor.WHITE, Anchor.TOP_LEFT, displaceX, displaceY, 640 - displaceX, -1, TextWrapMode.WRAP, true);
            displaceY += 125;
        }

        ultraliteCanvas.commit();
        screenIsClear = false;
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

    public void displayBitmap(Bitmap bmp) {
        Bitmap resizedBmp = Bitmap.createScaledBitmap(bmp, 620, 460, true); // 640 x 480

        changeUltraliteLayout(Layout.CANVAS);
        screenIsClear = false;

        Log.d(TAG, "Sending bitmap to Ultralite");
        ultraliteCanvas.drawBackground(resizedBmp, 50, 80);
        ultraliteCanvas.commit();
    }

    //don't show images on activelook (screen is too low res)
    public void displayReferenceCardImage(String title, String body, String imgUrl){
        if (screenToggleOff){
            return;
        }

        changeUltraliteLayout(Layout.CANVAS);
        ultraliteCanvas.clear();

        //make image
        //below works, but only for very, very low res/size images
        Anchor ultraliteImageAnchor = Anchor.CENTER;
        Picasso.get()
                .load(imgUrl)
                .into(new Target() {
                    @Override
                    public void onBitmapLoaded(Bitmap bitmap, Picasso.LoadedFrom from) {
                        // Use the bitmap
//                        LVGLImage ultraliteImage = LVGLImage.fromBitmap(getBitmapFromDrawable(context.getResources()), CF_INDEXED_2_BIT);
//                        LVGLImage ultraliteImage = LVGLImage.fromBitmap(bitmap, CF_INDEXED_2_BIT);
                        changeUltraliteLayout(Layout.CANVAS);

                        //send text first, cuz this is fast
                        ultraliteCanvas.createText(title, TextAlignment.AUTO, UltraliteColor.WHITE, Anchor.TOP_LEFT, 0, 0, 640, -1, TextWrapMode.WRAP, true);
                        ultraliteCanvas.createText(body, TextAlignment.AUTO, UltraliteColor.WHITE, Anchor.BOTTOM_LEFT, 0, 0, 640, -1, TextWrapMode.WRAP, true);
                        ultraliteCanvas.commit();
                        screenIsClear = false;

                        Log.d(TAG, "Sending image to Ultralite");
//                        ultraliteCanvas.createImage(ultraliteImage, ultraliteImageAnchor, 0, 0, true);
                        ultraliteCanvas.drawBackground(bitmap, 0, 0);

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

                    @Override
                    public void onBitmapFailed(Exception e, Drawable errorDrawable) {
                        // Handle the error
                        Log.d(TAG, "Bitmap failed");
                        e.printStackTrace();
                    }

                    @Override
                    public void onPrepareLoad(Drawable placeHolderDrawable) {
                        // Called before the image is loaded. You can set a placeholder if needed.
                    }
                });

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

    public void stopScrollingTextViewMode() {
//        if (connectedGlasses == null) {
//            return;
//        }
//
//        //clear the screen
//        connectedGlasses.clear();
    }

    public void scrollingTextViewIntermediateText(String text){
    }

    public void scrollingTextViewFinalText(String text){
        if (!isConnected()){
            return;
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

    public static String maybeReverseRTLString(String text) {
        StringBuilder result = new StringBuilder();
        StringBuilder rtlBuffer = new StringBuilder();

        for (char c : text.toCharArray()) {
            if (isRTLCharacter(c)) {
                rtlBuffer.append(c); // Append RTL characters to a buffer
            } else {
                if (rtlBuffer.length() > 0) {
                    result.append(rtlBuffer.reverse()); // Reverse and append RTL text when a non-RTL character is found
                    rtlBuffer.setLength(0); // Clear the buffer
                }
                result.append(c); // Append non-RTL characters directly to the result
            }
        }

        if (rtlBuffer.length() > 0) {
            result.append(rtlBuffer.reverse()); // Append any remaining RTL text in reverse
        }

        return result.toString();
    }

    private static boolean isRTLCharacter(char c) {
        Character.UnicodeBlock block = Character.UnicodeBlock.of(c);
        return block == Character.UnicodeBlock.ARABIC ||
                block == Character.UnicodeBlock.HEBREW ||
                block == Character.UnicodeBlock.SYRIAC ||
                block == Character.UnicodeBlock.ARABIC_SUPPLEMENT ||
                block == Character.UnicodeBlock.THAANA ||
                block == Character.UnicodeBlock.NKO ||
                block == Character.UnicodeBlock.SAMARITAN ||
                block == Character.UnicodeBlock.MANDAIC ||
                block == Character.UnicodeBlock.ARABIC_EXTENDED_A;
        // Add other RTL blocks as needed
    }
    public String[] maybeReverseRTLStringList(String[] in){
        String[] out = new String[in.length];
        for(int i = 0; i < in.length; i++)
            out[i] = maybeReverseRTLString(in[i]);
        return out;
    }

    public void displayPromptView(String prompt, String [] options){
        if (!isConnected()){
            return;
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
