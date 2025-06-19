package com.augmentos.augmentos_core.smarterglassesmanager.smartglassescommunicators;

import android.content.Context;
import android.graphics.Bitmap;
import android.util.Log;

import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.GlassesBluetoothSearchDiscoverEvent;
import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.TextToSpeechEvent;
import com.augmentos.augmentos_core.smarterglassesmanager.smartglassescommunicators.SmartGlassesCommunicator;
import com.augmentos.augmentos_core.smarterglassesmanager.smartglassescommunicators.SmartGlassesFontSize;
import com.augmentos.augmentos_core.smarterglassesmanager.supportedglasses.SmartGlassesDevice;
import com.augmentos.augmentos_core.smarterglassesmanager.utils.SmartGlassesConnectionState;

import org.greenrobot.eventbus.EventBus;

public class AudioWearableSGC extends SmartGlassesCommunicator {
    private static final String TAG = "WearableAi_AndroidWearableSGC";

    private static boolean killme;

    Context context;
    SmartGlassesDevice smartGlassesDevice;

    public AudioWearableSGC(Context context, SmartGlassesDevice smartGlassesDevice){
        super();

        //state information
        killme = false;
        mConnectState = SmartGlassesConnectionState.DISCONNECTED;
        this.smartGlassesDevice = smartGlassesDevice;
    }

    public void setFontSizes(){
    }

    public void connectToSmartGlasses(){
        connectionEvent(SmartGlassesConnectionState.CONNECTED);
    }

    public void blankScreen(){
    }

    public void displayRowsCard(String[] rowStrings){

    }

    @Override
    public void destroy() {
        // Reset killme flag and connection state
        killme = true;
        mConnectState = SmartGlassesConnectionState.DISCONNECTED;

        // Clear references to avoid memory leaks
        this.context = null;
        this.smartGlassesDevice = null;

        // Log the destruction
        Log.d(TAG, "AudioWearableSGC destroyed successfully.");
    }


    public void displayReferenceCardSimple(String title, String body){
        Log.d(TAG, "TTS reference card");
        EventBus.getDefault().post(new TextToSpeechEvent(title + ", " + body, "english"));
    }

    public void displayReferenceCardImage(String title, String body, String imgUrl){
        Log.d(TAG, "TTS reference card");
        EventBus.getDefault().post(new TextToSpeechEvent(title + ", " + body, "english"));
    }

    public void displayBulletList(String title, String [] bullets){
        displayBulletList(title, bullets, 0);
    }

    public void displayBulletList(String title, String [] bullets, int lingerTime){

    }

    public void displayTextWall(String text){}
    public void displayDoubleTextWall(String textTop, String textBottom){}

    public void stopScrollingTextViewMode() {
    }

    public void startScrollingTextViewMode(String title){
    }

    public void scrollingTextViewIntermediateText(String text){
    }

    public void scrollingTextViewFinalText(String text){
    }

    public void showHomeScreen() {
    }

    public void displayPromptView(String prompt, String [] options){
    }

    public void displayTextLine(String text){
        Log.d(TAG, "displayTextLine: " + text);
        EventBus.getDefault().post(new TextToSpeechEvent(text, "english"));
    }

    @Override
    public void displayBitmap(Bitmap bmp) {

    }

    @Override
    public void displayCustomContent(String json) {
        displayTextLine(json);
    }

    @Override
    public void findCompatibleDeviceNames() {
        EventBus.getDefault().post(new GlassesBluetoothSearchDiscoverEvent(smartGlassesDevice.deviceModelName, "NOTREQUIREDSKIP"));
        this.destroy();
    }

    public void showNaturalLanguageCommandScreen(String prompt, String naturalLanguageArgs){
    }

    public void updateNaturalLanguageCommandScreen(String naturalLanguageArgs){
    }

    public void setFontSize(SmartGlassesFontSize fontSize){}
}