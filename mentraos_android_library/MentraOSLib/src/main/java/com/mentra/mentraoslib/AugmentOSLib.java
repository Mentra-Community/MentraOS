package com.mentra.mentraoslib;

import static com.mentra.mentraoslib.AugmentOSGlobalConstants.AugmentOSManagerPackageName;

import android.content.Context;
import android.graphics.Bitmap;
import android.util.Log;

import com.mentra.mentraoslib.events.BulletPointListViewRequestEvent;
import com.mentra.mentraoslib.events.CommandTriggeredEvent;
import com.mentra.mentraoslib.events.CoreToManagerOutputEvent;
import com.mentra.mentraoslib.events.DisplayCustomContentRequestEvent;
import com.mentra.mentraoslib.events.DoubleTextWallViewRequestEvent;
import com.mentra.mentraoslib.events.FinalScrollingTextRequestEvent;
import com.mentra.mentraoslib.events.FocusChangedEvent;
import com.mentra.mentraoslib.events.GlassesPovImageEvent;
import com.mentra.mentraoslib.events.GlassesTapOutputEvent;
import com.mentra.mentraoslib.events.HomeScreenEvent;
import com.mentra.mentraoslib.events.ManagerToCoreRequestEvent;
import com.mentra.mentraoslib.events.ReferenceCardImageViewRequestEvent;
import com.mentra.mentraoslib.events.ReferenceCardSimpleViewRequestEvent;
import com.mentra.mentraoslib.events.RegisterCommandRequestEvent;
import com.mentra.mentraoslib.events.RowsCardViewRequestEvent;
import com.mentra.mentraoslib.events.ScrollingTextViewStartRequestEvent;
import com.mentra.mentraoslib.events.ScrollingTextViewStopRequestEvent;
import com.mentra.mentraoslib.events.SendBitmapViewRequestEvent;
import com.mentra.mentraoslib.events.SmartRingButtonOutputEvent;
import com.mentra.mentraoslib.events.SpeechRecOutputEvent;
import com.mentra.mentraoslib.events.StartAsrStreamRequestEvent;
import com.mentra.mentraoslib.events.StopAsrStreamRequestEvent;
import com.mentra.mentraoslib.events.SubscribeDataStreamRequestEvent;
import com.mentra.mentraoslib.events.TextLineViewRequestEvent;
import com.mentra.mentraoslib.events.TextWallViewRequestEvent;
import com.mentra.mentraoslib.events.TranslateOutputEvent;

import org.greenrobot.eventbus.Subscribe;

import java.util.HashMap;

public class AugmentOSLib {
    public String TAG = "AugmentOSLib_AugmentOSLib";

    private final TPABroadcastReceiver augmentosReceiver;
    private final TPABroadcastSender augmentosSender;
    private final Context mContext;
    private AugmentOSCallbackMapper augmentosCallbackMapper;
    private FocusCallback focusCallback;

    public HashMap<DataStreamType, SubscriptionCallback> subscribedDataStreams;

    private SmartGlassesAndroidService smartGlassesAndroidService;

    public AugmentOSLib(Context context){
        this.mContext = context;
        augmentosCallbackMapper = new AugmentOSCallbackMapper();
        augmentosReceiver = new TPABroadcastReceiver(context);
        augmentosSender = new TPABroadcastSender(context);
        subscribedDataStreams = new HashMap<DataStreamType, SubscriptionCallback>();

        //register subscribers on EventBus
        AugmentOSLibBus.getInstance().register(this);
    }

    //register a new command
    public void registerCommand(AugmentOSCommand augmentosCommand, AugmentOSCallback callback){
        // augmentosCommand.packageName = mContext.getPackageName();
        augmentosCommand.serviceName = mContext.getClass().getName();

        augmentosCallbackMapper.putCommandWithCallback(augmentosCommand, callback);
        AugmentOSLibBus.getInstance().post(new RegisterCommandRequestEvent(augmentosCommand));
    }

    //register our app with the AugmentOS
//    public void registerApp(String appName, String appDescription) {
//        registerApp(appName, appDescription, new AugmentOSCommand[]{});
//    }
//
//    public void registerApp(String appName, String appDescription, AugmentOSCommand[] commandList) {
//        String packageName = mContext.getPackageName();
//        String serviceName = mContext.getClass().getName();
//        ThirdPartyApp tpa = new ThirdPartyApp(appName, appDescription, packageName, serviceName, commandList);
//        AugmentOSLibBus.getInstance().post(new RegisterTpaRequestEvent(tpa));
//
//        for (AugmentOSCommand command : commandList) {
//
//        }
//    }

    public void subscribeCoreToManagerMessages(CoreToManagerCallback callback){
        if (!mContext.getPackageName().equals(AugmentOSManagerPackageName)) {
            Log.d(TAG, "Attempted to subscribe to CoreToManagerMessages from a non-manager package");
            return;
        };

        subscribedDataStreams.put(DataStreamType.CORE_SYSTEM_MESSAGE, callback);
    }

    public void requestTranscription(String language){
        String languageLocale = SpeechRecUtils.languageToLocale(language);
        subscribe(new StartAsrStreamRequestEvent(languageLocale));
    }

    public void stopTranscription(String language){
        String languageLocale = SpeechRecUtils.languageToLocale(language);
        subscribe(new StopAsrStreamRequestEvent(languageLocale));
    }

    public void requestTranslation(String fromLanguage, String toLanguage){
        String fromLanguageLocale = SpeechRecUtils.languageToLocale(fromLanguage);
        String toLanguageLocale = SpeechRecUtils.languageToLocale(toLanguage);
        subscribe(new StartAsrStreamRequestEvent(fromLanguageLocale, toLanguageLocale));
    }

    public void stopTranslation(String fromLanguage, String toLanguage){
        String fromLanguageLocale = SpeechRecUtils.languageToLocale(fromLanguage);
        String toLanguageLocale = SpeechRecUtils.languageToLocale(toLanguage);
        subscribe(new StopAsrStreamRequestEvent(fromLanguageLocale, toLanguageLocale));
    }

    public void subscribe(StartAsrStreamRequestEvent startAsrStreamRequestEvent) {
        AugmentOSLibBus.getInstance().post((StartAsrStreamRequestEvent) startAsrStreamRequestEvent);
    }

    public void subscribe(StopAsrStreamRequestEvent stopAsrStreamRequestEvent) {
        AugmentOSLibBus.getInstance().post((StopAsrStreamRequestEvent) stopAsrStreamRequestEvent);
    }

    public void subscribe(DataStreamType dataStreamType, TranscriptCallback callback){
        subscribedDataStreams.put(dataStreamType, callback);

        //trigger event to change language if needed
        AugmentOSLibBus.getInstance().post(new SubscribeDataStreamRequestEvent(dataStreamType));
    }

    public void subscribe(DataStreamType dataStreamType, TranslateCallback callback){
        subscribedDataStreams.put(dataStreamType, callback);

        //trigger event to change language if needed
        AugmentOSLibBus.getInstance().post(new SubscribeDataStreamRequestEvent(dataStreamType));
    }

    public void subscribe(DataStreamType dataStreamType, ButtonCallback callback){
        subscribedDataStreams.put(dataStreamType, callback);
    }

    public void subscribe(DataStreamType dataStreamType, TapCallback callback){
        subscribedDataStreams.put(dataStreamType, callback);
    }

    public void subscribe(DataStreamType dataStreamType, GlassesPovImageCallback callback){
        subscribedDataStreams.put(dataStreamType, callback);
    }

//    //TPA request to be the app in focus - AugmentOS has to grant this request
//    public void requestFocus(FocusCallback callback){
//        focusCallback = callback;
//        AugmentOSLibBus.getInstance().post(new FocusRequestEvent(true));
//    }


    public void sendCustomContent(String json) {
        AugmentOSLibBus.getInstance().post(new DisplayCustomContentRequestEvent(json));
    }

    //show a reference card on the smart glasses with title and body text
    public void sendReferenceCard(String title, String body) {
        AugmentOSLibBus.getInstance().post(new ReferenceCardSimpleViewRequestEvent(title, body));
    }

    //show a bullet point list card on the smart glasses with title and bullet points
    public void sendBulletPointList(String title, String [] bullets) {
        AugmentOSLibBus.getInstance().post(new BulletPointListViewRequestEvent(title, bullets));
    }

    public void sendReferenceCard(String title, String body, String imgUrl) {
        AugmentOSLibBus.getInstance().post(new ReferenceCardImageViewRequestEvent(title, body, imgUrl));
    }

    public void startScrollingText(String title){
        AugmentOSLibBus.getInstance().post(new ScrollingTextViewStartRequestEvent(title));
    }

    public void pushScrollingText(String text){
        AugmentOSLibBus.getInstance().post(new FinalScrollingTextRequestEvent(text));
    }

    public void stopScrollingText(){
        AugmentOSLibBus.getInstance().post(new ScrollingTextViewStopRequestEvent());
    }

    public void sendTextLine(String text) {
        AugmentOSLibBus.getInstance().post(new TextLineViewRequestEvent(text));
    }

    public void sendTextWall(String text){
        AugmentOSLibBus.getInstance().post(new TextWallViewRequestEvent(text));
    }

    public void sendDoubleTextWall(String textTop, String textBottom){
        AugmentOSLibBus.getInstance().post(new DoubleTextWallViewRequestEvent(textTop, textBottom));
    }

    public void sendRowsCard(String[] rowStrings){
        AugmentOSLibBus.getInstance().post(new RowsCardViewRequestEvent(rowStrings));
    }

    public void sendBitmap(Bitmap bmp){
        AugmentOSLibBus.getInstance().post(new SendBitmapViewRequestEvent(bmp));
    }

    public void sendHomeScreen(){
        AugmentOSLibBus.getInstance().post(new HomeScreenEvent());
    }

    public void getSelectedLiveCaptionsTranslation(){
        AugmentOSLibBus.getInstance().post(new HomeScreenEvent());
    }

    public void getChosenTranscribeLanguage(){
        AugmentOSLibBus.getInstance().post(new HomeScreenEvent());
    }

    public void sendDataFromManagerToCore(String jsonData) {
        AugmentOSLibBus.getInstance().post(new ManagerToCoreRequestEvent(jsonData));
    }

    @Subscribe
    public void onCommandTriggeredEvent(CommandTriggeredEvent receivedEvent){
        AugmentOSCommand command = receivedEvent.command;
        // String args = receivedEvent.args;
        // long commandTriggeredTime = receivedEvent.commandTriggeredTime;
        Log.d(TAG, " " + command.getId());
        Log.d(TAG, " " + command.getDescription());
        receivedEvent.command.callback.runCommand(receivedEvent.args, receivedEvent.commandTriggeredTime);
//        //call the callback
//        AugmentOSCallback callback = augmentosCallbackMapper.getCommandCallback(command);
//        if (callback != null){
//            callback.runCommand(args, commandTriggeredTime);
//        }
        Log.d(TAG, "Callback called");
    }

    @Subscribe
    public void onTranscript(SpeechRecOutputEvent event) {
        String text = event.text;
        String languageCode = event.languageCode;
        long time = event.timestamp;

    }

    @Subscribe
    public void onTranslateTranscript(TranslateOutputEvent event) {
        String text = event.text;
    }

    @Subscribe
    public void onSmartRingButtonEvent(SmartRingButtonOutputEvent event) {
        int buttonId = event.buttonId;
        long time = event.timestamp;
        if (subscribedDataStreams.containsKey(DataStreamType.SMART_RING_BUTTON)) {
            ((ButtonCallback)subscribedDataStreams.get(DataStreamType.SMART_RING_BUTTON)).call(buttonId, time, event.isDown);
        }
    }

    @Subscribe
    public void onGlassesTapSideEvent(GlassesTapOutputEvent event) {
        int numTaps = event.numTaps;
        boolean sideOfGlasses = event.sideOfGlasses;
        long time = event.timestamp;
        if (subscribedDataStreams.containsKey(DataStreamType.GLASSES_SIDE_TAP)) {
            ((TapCallback)subscribedDataStreams.get(DataStreamType.GLASSES_SIDE_TAP)).call(numTaps, sideOfGlasses, time);
        }
    }

    @Subscribe
    public void onFocusChange(FocusChangedEvent event) {
        if (focusCallback != null){
            focusCallback.runFocusChange(event.focusState);
        }
    }

    @Subscribe
    public void onCoreToManagerEvent(CoreToManagerOutputEvent event) {
        if (subscribedDataStreams.containsKey(DataStreamType.CORE_SYSTEM_MESSAGE)) {
            ((CoreToManagerCallback)subscribedDataStreams.get(DataStreamType.CORE_SYSTEM_MESSAGE)).call(event.jsonData);
        }
    }


    @Subscribe
    public void onGlassesPovImageEvent(GlassesPovImageEvent event) {
        if (subscribedDataStreams.containsKey(DataStreamType.GLASSES_POV_IMAGE)) {
            ((GlassesPovImageCallback)subscribedDataStreams.get(DataStreamType.GLASSES_POV_IMAGE)).call(event.encodedImgString);
        }
    }

    public void deinit() {
        AugmentOSLibBus.getInstance().unregister(this);
        if (augmentosReceiver != null) {
            augmentosReceiver.destroy();
        }
        if (augmentosSender != null) {
            augmentosSender.destroy();
        }
    }
}
