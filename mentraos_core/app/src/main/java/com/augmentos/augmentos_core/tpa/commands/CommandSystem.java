package com.augmentos.augmentos_core.tpa.commands;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.util.Base64;
import android.util.Log;


import com.mentra.mentraoslib.AugmentOSCallbackMapper;
import com.mentra.mentraoslib.FocusStates;
import com.mentra.mentraoslib.AugmentOSCommand;
import com.mentra.mentraoslib.AugmentOSCallback;
import com.mentra.mentraoslib.events.BulletPointListViewRequestEvent;
import com.mentra.mentraoslib.events.CommandTriggeredEvent;
import com.mentra.mentraoslib.events.FinalScrollingTextRequestEvent;
import com.mentra.mentraoslib.events.FocusChangedEvent;
import com.mentra.mentraoslib.events.FocusRequestEvent;
import com.mentra.mentraoslib.events.IntermediateScrollingTextRequestEvent;
import com.mentra.mentraoslib.events.ReferenceCardImageViewRequestEvent;
import com.mentra.mentraoslib.events.ReferenceCardSimpleViewRequestEvent;
import com.mentra.mentraoslib.events.RegisterCommandRequestEvent;
import com.augmentos.augmentos_core.tpa.eventbusmessages.StartLiveCaptionsEvent;
import com.augmentos.augmentos_core.tpa.eventbusmessages.StopLiveCaptionsEvent;
import com.mentra.mentraoslib.events.ScrollingTextViewStartRequestEvent;
import com.mentra.mentraoslib.events.ScrollingTextViewStopRequestEvent;
import com.mentra.mentraoslib.events.TextLineViewRequestEvent;

import com.augmentos.augmentos_core.tpa.eventbusmessages.HomeScreenEvent;
import com.augmentos.augmentos_core.tpa.eventbusmessages.TPARequestEvent;

import org.greenrobot.eventbus.EventBus;
import org.greenrobot.eventbus.Subscribe;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.ObjectInputStream;
import java.io.ObjectOutputStream;
import java.util.Map;
import java.util.UUID;

public class CommandSystem {
    private String TAG = "WearableAi_CommandSystem";

    //hold all registered commands, mostly from TPAs
    public AugmentOSCallbackMapper augmentosCallbackMapper;

    //voice command system
    //VoiceCommandServer voiceCommandServer;

    //command timeout
    class AppPrivilegeTimeout {
        public String appId;
        public long timeStart;

        AppPrivilegeTimeout(String appId, long timeStart) {
            this.appId = appId;
            this.timeStart = timeStart;
        }
    }

    private AppPrivilegeTimeout appPrivilegeTimeout;
    private FocusedApp focusedApp; //if an app was triggered and took focus by starting a mode, then this will tell us which app is currently in focus

    Context mContext;

    final String commandStartString = "command--";
    final int commandResponseWindowTime = 20000; //how long a TPA has to send a response request event
    final int suspendFocusTime = 8000; //how long we allow an out of focus app to display before switching back to in-focus app
    public final long NO_UNSUSPEND_DELAY = 0;

    //handler for suspension focus changes
    Handler focusHandler;

    public CommandSystem(Context context) {
        mContext = context;

        augmentosCallbackMapper = new AugmentOSCallbackMapper();

        loadDefaultCommands();

        //start voice command server to parse transcript for voice command
        //voiceCommandServer = new VoiceCommandServer(context);
        updateInterfaceCommands();

        //setup a handler to handle suspension focus changes
        focusHandler = new Handler();

        //load the commands we saved to storage
        loadCommands();

        //subscribe to event bus events
        EventBus.getDefault().register(this);
    }

    public void launchLiveCaptions(String args, long commandTime) {
        EventBus.getDefault().post(new StartLiveCaptionsEvent());
    }

    public void launchTestCard(String args, long commandTime) {
        EventBus.getDefault().post(new StopLiveCaptionsEvent());
        EventBus.getDefault().post(new ReferenceCardSimpleViewRequestEvent("Test Card", "This is a test card triggered by voice command."));
    }

    public void goHome(String args, long commandTime) {
        clearFocusedApp();
        EventBus.getDefault().post(new HomeScreenEvent());
    }

    public void loadDefaultCommands() {
        //live life captions - test scrolling view text
        registerLocalCommand("Live Captions", UUID.fromString("933b8950-412e-429e-8fb6-430f973cc9dc"), new String[]{"live captions", "live life captions", "captions", "transcription"}, "Starts streaming captions live to the glasses display.", this::launchLiveCaptions);

        //test reference card
        registerLocalCommand("Test", UUID.fromString("f4290426-18d5-431a-aea4-21844b832735"), new String[]{"test", "test", "show me a test card", "test card", "testing", "show test card"}, "Shows a test Reference Card on the glasses display.", this::launchTestCard);

        //go home
        registerLocalCommand("Go Home", UUID.fromString("07111c55-b8e0-41d2-a6dd-d994ab946d1e"), new String[]{"home", "go home", "quit", "stop"}, "Exits current mode and goes back to the home screen.", this::goHome);

//        //blank screen
//        registerCommand("Blank Screen", UUID.fromString("93401154-b4ab-4166-9aa3-58b79db41ff0"), new String[] { "turn off display", "blank screen" }, "Makes the smart glasses display turn off or go blank.", this::dummyCallback);
    }

    public void registerLocalCommand(String name, UUID id, String[] phrases, String description, AugmentOSCallback callback) {
        //add a new command
//        AugmentOSCommand newCommand = new AugmentOSCommand(name, id, phrases, description);
//        newCommand.packageName = mContext.getPackageName();
//        newCommand.serviceName = mContext.getClass().getName();
//
//        augmentosCallbackMapper.putCommandWithCallback(newCommand, callback);
    }

    public void saveCommand(AugmentOSCommand command) {
        //save command to memory
        augmentosCallbackMapper.putCommandWithCallback(command, null);

        //save command to storage
        // Get a reference to the SharedPreferences object
        SharedPreferences sharedPreferences = mContext.getSharedPreferences("AugmentOSPrefs", Context.MODE_PRIVATE);

        // Add command to the SharedPreferences
        String commandSerialized = serializeObject(command);

        SharedPreferences.Editor editor = sharedPreferences.edit();
        String commandId = commandStartString + command.getId();
        editor.remove(commandId);
        editor.putString(commandId, commandSerialized);
        editor.apply();
    }

    public void loadCommands() {
        // Get a reference to the SharedPreferences object
        SharedPreferences sharedPreferences = mContext.getSharedPreferences("AugmentOSPrefs", Context.MODE_PRIVATE);

        // Retrieve values from the SharedPreferences
        Map<String, ?> allEntries = sharedPreferences.getAll();
        for (Map.Entry<String, ?> entry : allEntries.entrySet()) {
            String key = entry.getKey();
            if (key.startsWith(commandStartString)) {
                Object value = entry.getValue();
                if (value instanceof String) {
                    AugmentOSCommand command = (AugmentOSCommand) deserializeObject((String) value);
                    augmentosCallbackMapper.putCommandWithCallback(command, null);
                }
            }
        }

        updateInterfaceCommands();
    }

    public String serializeObject(Object object) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try {
            ObjectOutputStream outputStream = new ObjectOutputStream(out);
            outputStream.writeObject(object);
            outputStream.close();
        } catch (IOException e) {
            e.printStackTrace();
        }
        return Base64.encodeToString(out.toByteArray(), Base64.DEFAULT);
    }

    public static Object deserializeObject(String serialized) {
        byte[] bytes = Base64.decode(serialized, Base64.DEFAULT);
        Object object = null;
        try {
            ObjectInputStream inputStream = new ObjectInputStream(new ByteArrayInputStream(bytes));
            object = inputStream.readObject();
        } catch (IOException | ClassNotFoundException e) {
            e.printStackTrace();
        }
        return object;
    }

    private void updateInterfaceCommands() {
        //voiceCommandServer.updateVoiceCommands(augmentosCallbackMapper.getCommandsList());
    }

    @Subscribe
    public void onRegisterCommandRequestEvent(RegisterCommandRequestEvent receivedEvent) {
        Log.d(TAG, "Command was registered");
        saveCommand(receivedEvent.command); //save the command to be loaded later
        updateInterfaceCommands();
    }

    @Subscribe
    public void onCommandTriggeredEvent(CommandTriggeredEvent receivedEvent) {
//        AugmentOSCommand command = receivedEvent.command;
//        String args = receivedEvent.args;
//        long commandTriggeredTime = receivedEvent.commandTriggeredTime;
//        if (command != null) {
//            //start the app privilege timer as user triggered this command
//            // Log.d(TAG, "Starting app privilege timer for app: " + receivedEvent.command.packageName);
//            // appPrivilegeTimeout = new AppPrivilegeTimeout(receivedEvent.command.packageName, System.currentTimeMillis());
//
//            //run if it's a locally registered command
//            AugmentOSCallback callback = augmentosCallbackMapper.getCommandCallback(command);
//            if (callback != null) {
//                Log.d(TAG, "Running command");
//                suspendFocusIfNotFocused(mContext.getPackageName());
//                callback.runCommand(args, commandTriggeredTime);
//            }
//        }
    }


//    @Subscribe
////    public void onAugmentOSStealFocus(AugmentOSStealFocus receivedEvent) {
////        if (receivedEvent.inFocus == true){
////            suspendFocusedApp(NO_UNSUSPEND_DELAY);
////        } else {
////            unsuspendFocusedApp();
////        }
////    }

    public void destroy() {
        //if (voiceCommandServer != null) {
        //    voiceCommandServer.destroy();
        //}
        EventBus.getDefault().unregister(this);
    }

    //check is an app making a request should be granted that specific request right now
    private boolean checkAppHasPrivilege(String eventId, String sendingPackage){
        Log.d(TAG, "event requesting privilege: " + eventId);
        return true;



//        //check if app has focus - if so, it can do whatever it wants
//        if (isInActiveFocus(sendingPackage)){
//            return true;
//        }
//
//        //if the app doesn't have focus, then we have to check if its been recently triggered and thus allowed to do something
//        if (eventId.equals(ReferenceCardSimpleViewRequestEvent.eventId) | eventId.equals(ReferenceCardImageViewRequestEvent.eventId) | eventId.equals(ReferenceCardImageViewRequestEvent.eventId) | eventId.equals(BulletPointListViewRequestEvent.eventId) | eventId.equals(ScrollingTextViewStartRequestEvent.eventId) | eventId.equals(FocusRequestEvent.eventId)) {
//            //if the app took too long to respond, don't allow it to run anything
//            if (appPrivilegeTimeout == null) {
//                return false;
//            }
//
//            //if the app responded in good time (and it's the same app that was actually triggered, then allow the request
//            if (sendingPackage.equals(appPrivilegeTimeout.appId)) {
//                if ((System.currentTimeMillis() - appPrivilegeTimeout.timeStart) < commandResponseWindowTime) {
//                    return true;
//                }
//            }
//        }
//
//        //if not focused and not recently triggered, the app does not have permission to run anything
//        return false;
    }

    //if package asked for focus, give it to them (should always run checkPrivileges before running this
    public void focusRequested(String sendingAppPackage, boolean focusRequest){
        Log.d(TAG, "Focus being requested by: " + sendingAppPackage);
        //if package asked to drop focus
        if (!focusRequest){
            if (focusedApp.getAppPackage().equals(sendingAppPackage)){
                clearFocusedApp();
            }
        }

        setFocusedApp(sendingAppPackage);
    }

    //if a package that isn't in focus requests and event, and it's granted, we need to suspend focus for some time so the unfocused app has time to display before returning to the focused app
    public void suspendFocusIfNotFocused(String sendingAppPackage){
        Log.d(TAG, "Suspend focus if not focused: " + sendingAppPackage);
        //if no app is in focus, do nothing
        if (focusedApp == null){
            return;
        }

        //if the app is in focus already, no need to suspend
        if (sendingAppPackage.equals(focusedApp.getAppPackage())){
            return;
        }

        //if the app isn't in focus, suspend the current app for certain amount of time
        suspendFocusedApp(suspendFocusTime);
    }

    //respond and approve events below
    @Subscribe
    public void onTPARequestEvent(TPARequestEvent receivedEvent) {
        Log.d(TAG, "onTPARequestEvent");

        //map from id to event for all events that don't need permissions
        switch (receivedEvent.eventId) {
            case RegisterCommandRequestEvent.eventId:
                Log.d(TAG, "Resending register command request event");
                EventBus.getDefault().post((RegisterCommandRequestEvent) receivedEvent.serializedEvent);
                return;
        }

        //check if the app making the request has privilege, only run it if it does have privilege
        if (checkAppHasPrivilege(receivedEvent.eventId, receivedEvent.sendingPackage)) { //comment out check for privilege until this is a problem - TPAs should all request check for privilege anyway
            Log.d(TAG, "Allowing and resending event: ," + receivedEvent.eventId + "requested by: " + receivedEvent.sendingPackage);
            //map from id to event for all events that need permissions
            switch (receivedEvent.eventId) {
                case ReferenceCardSimpleViewRequestEvent.eventId:
                    suspendFocusIfNotFocused(receivedEvent.sendingPackage);
                    EventBus.getDefault().post((ReferenceCardSimpleViewRequestEvent) receivedEvent.serializedEvent);
                    break;
                case ReferenceCardImageViewRequestEvent.eventId:
                    suspendFocusIfNotFocused(receivedEvent.sendingPackage);
                    EventBus.getDefault().post((ReferenceCardImageViewRequestEvent) receivedEvent.serializedEvent);
                    break;
                case BulletPointListViewRequestEvent.eventId:
                    suspendFocusIfNotFocused(receivedEvent.sendingPackage);
                    EventBus.getDefault().post((BulletPointListViewRequestEvent) receivedEvent.serializedEvent);
                    break;
                case ScrollingTextViewStartRequestEvent.eventId: //mode start command - gives app focus
                    suspendFocusIfNotFocused(receivedEvent.sendingPackage);
                    EventBus.getDefault().post((ScrollingTextViewStartRequestEvent) receivedEvent.serializedEvent);
                    break;
                case ScrollingTextViewStopRequestEvent.eventId:
                    suspendFocusIfNotFocused(receivedEvent.sendingPackage);
                    EventBus.getDefault().post((ScrollingTextViewStopRequestEvent) receivedEvent.serializedEvent);
                    break;
                case FinalScrollingTextRequestEvent.eventId:
                    suspendFocusIfNotFocused(receivedEvent.sendingPackage);
                    EventBus.getDefault().post((FinalScrollingTextRequestEvent) receivedEvent.serializedEvent);
                    break;
                case IntermediateScrollingTextRequestEvent.eventId:
                    suspendFocusIfNotFocused(receivedEvent.sendingPackage);
                    EventBus.getDefault().post((IntermediateScrollingTextRequestEvent) receivedEvent.serializedEvent);
                    break;
                case TextLineViewRequestEvent.eventId:
                    suspendFocusIfNotFocused(receivedEvent.sendingPackage);
                    EventBus.getDefault().post((TextLineViewRequestEvent) receivedEvent.serializedEvent);
                    break;
                case FocusRequestEvent.eventId:
                    focusRequested(receivedEvent.sendingPackage, ((FocusRequestEvent) receivedEvent.serializedEvent).focusRequest);
                    break;
            }
        } else {
            Log.d(TAG, "Denied event requested by: " + receivedEvent.sendingPackage);
        }
    }

    private void setFocusedApp(String sendingAppPackage){
        Log.d(TAG, "Focusing app: " + sendingAppPackage);
        focusedApp = new FocusedApp(FocusStates.IN_FOCUS, sendingAppPackage);

        //send out event of which app is now in focus
        EventBus.getDefault().post(new FocusChangedEvent(FocusStates.IN_FOCUS, sendingAppPackage));
    }

    private void clearFocusedApp(){
        Log.d(TAG, "Clearing focused app.");
        //send out event to the app which has been revoked focus
        if (focusedApp == null){
            return;
        }

        EventBus.getDefault().post(new FocusChangedEvent(FocusStates.OUT_FOCUS, focusedApp.getAppPackage()));

        //clear current focus
        focusHandler.removeCallbacksAndMessages(null);
        focusedApp = null; //clear the focused app
    }

    private boolean isInActiveFocus(String sendingAppPackage){
        if (focusedApp != null){
            if (focusedApp.getAppPackage().equals(sendingAppPackage)){
                if (focusedApp.getFocusState().equals(FocusStates.IN_FOCUS)){
                    return true;
                }
            }
        }
        return false;
    }

    private void unsuspendFocusedApp(){
        if (focusedApp != null) {
            Log.d(TAG, "Unsuspending focused app: " + focusedApp.getAppPackage());
            setFocusedApp(focusedApp.getAppPackage());
        }
    }

    private void suspendFocusedApp(long timeout){
        if (focusedApp == null){
            return;
        }

        Log.d(TAG, "Suspending focused app: " + focusedApp.getAppPackage());

        focusedApp.setFocusState(FocusStates.IN_FOCUS_SUSPENDED);

        //send out event to the app which has been revoked focus
        EventBus.getDefault().post(new FocusChangedEvent(FocusStates.IN_FOCUS_SUSPENDED, focusedApp.getAppPackage()));

        //setup a handler to return focus in time, if there is any delay at all
        if (timeout > 0) {
            focusHandler.postDelayed(new Runnable() {
                @Override
                public void run() {
                    unsuspendFocusedApp();
                }
            }, timeout);
        }
    }

}
