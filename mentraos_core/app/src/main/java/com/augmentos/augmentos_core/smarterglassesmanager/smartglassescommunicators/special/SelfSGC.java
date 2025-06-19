package com.augmentos.augmentos_core.smarterglassesmanager.smartglassescommunicators.special;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.Base64;

import com.mentra.mentraoslib.events.GlassesPovImageEvent;
import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.GlassesBluetoothSearchDiscoverEvent;
import com.augmentos.augmentos_core.smarterglassesmanager.smartglassescommunicators.SmartGlassesCommunicator;
import com.augmentos.augmentos_core.smarterglassesmanager.smartglassescommunicators.SmartGlassesFontSize;
import com.augmentos.augmentos_core.smarterglassesmanager.supportedglasses.SmartGlassesDevice;
import com.augmentos.augmentos_core.smarterglassesmanager.utils.SmartGlassesConnectionState;

import org.greenrobot.eventbus.EventBus;

public class SelfSGC extends SmartGlassesCommunicator {
    private static final String TAG = "WearableAi_SelfSGC";

    public void displayRowsCard(String[] rowStrings){

    }

    @Override
    public void showNaturalLanguageCommandScreen(String prompt, String naturalLanguageArgs) {

    }

    @Override
    public void updateNaturalLanguageCommandScreen(String naturalLanguageArgs) {

    }

    @Override
    public void scrollingTextViewIntermediateText(String text) {

    }

    @Override
    public void scrollingTextViewFinalText(String text) {

    }

    @Override
    public void stopScrollingTextViewMode() {

    }

    @Override
    public void displayPromptView(String title, String[] options) {

    }

    @Override
    public void displayTextLine(String text) {

    }

    @Override
    public void displayBitmap(Bitmap bmp) {

    }

    @Override
    public void displayCustomContent(String json) {

    }

    @Override
    public void showHomeScreen() {

    }

    Context context;
    SmartGlassesDevice smartGlassesDevice;

    public SelfSGC(Context context, SmartGlassesDevice smartGlassesDevice){
        super();
        this.context = context;

        this.smartGlassesDevice = smartGlassesDevice;
        //state information
        mConnectState = SmartGlassesConnectionState.DISCONNECTED;
    }

    //not used/valid yet
    @Override
    protected void setFontSizes(){
        LARGE_FONT = 3;
        MEDIUM_FONT = 2;
        SMALL_FONT = 0;
    }

    public void connectToSmartGlasses(){
        // Right now, this is the code running onboard our android-based meta ray-ban alternative
        // It has speakers, mic, camera, wifi
        // Let's just figure out camera for now
        // Use CameraRecordingService for this
    }



    public void destroy(){}

    @Override
    public void displayReferenceCardSimple(String title, String body) {

    }

    @Override
    public void displayTextWall(String text) {

    }

    @Override
    public void displayDoubleTextWall(String textTop, String textBottom) {

    }

    @Override
    public void displayReferenceCardImage(String title, String body, String imgUrl) {

    }

    @Override
    public void displayBulletList(String title, String[] bullets) {

    }


    @Override
    public void findCompatibleDeviceNames() {
        EventBus.getDefault().post(new GlassesBluetoothSearchDiscoverEvent(smartGlassesDevice.deviceModelName,"NOTREQUIREDSKIP"));
        this.destroy();
    }

    @Override
    public void blankScreen() {

    }

    public void handleImage(byte [] raw_data, long imageTime){
        //convert to bitmap
        Bitmap bitmap = BitmapFactory.decodeByteArray(raw_data, 0, raw_data.length);

        //save and process 1 image at set frequency
        sendPovImage(raw_data, imageTime);
    }

    public void sendPovImage(byte [] img, long imageTime){
        String encodedImage = Base64.encodeToString(img, Base64.DEFAULT);
        EventBus.getDefault().post(new GlassesPovImageEvent(encodedImage, imageTime));
    }

    public void setFontSize(SmartGlassesFontSize fontSize){}
}
