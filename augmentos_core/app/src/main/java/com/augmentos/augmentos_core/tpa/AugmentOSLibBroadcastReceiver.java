package com.augmentos.augmentos_core.tpa;

import static com.augmentos.augmentoslib.AugmentOSGlobalConstants.AugmentOSManagerPackageName;
import static com.augmentos.augmentoslib.AugmentOSGlobalConstants.EVENT_ID;
import static com.augmentos.augmentoslib.AugmentOSGlobalConstants.APP_PKG_NAME;
import static com.augmentos.augmentoslib.AugmentOSGlobalConstants.EVENT_BUNDLE;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.util.Log;

import com.augmentos.augmentoslib.AugmentOSGlobalConstants;
import com.augmentos.augmentoslib.events.BulletPointListViewRequestEvent;
import com.augmentos.augmentoslib.events.DisplayCustomContentRequestEvent;
import com.augmentos.augmentoslib.events.DoubleTextWallViewRequestEvent;
import com.augmentos.augmentoslib.events.FinalScrollingTextRequestEvent;
import com.augmentos.augmentoslib.events.FocusRequestEvent;
import com.augmentos.augmentoslib.events.HomeScreenEvent;
import com.augmentos.augmentoslib.events.ManagerToCoreRequestEvent;
import com.augmentos.augmentoslib.events.ReferenceCardImageViewRequestEvent;
import com.augmentos.augmentoslib.events.ReferenceCardSimpleViewRequestEvent;
import com.augmentos.augmentoslib.events.RegisterCommandRequestEvent;
import com.augmentos.augmentoslib.events.RegisterTpaRequestEvent;
import com.augmentos.augmentoslib.events.RowsCardViewRequestEvent;
import com.augmentos.augmentoslib.events.ScrollingTextViewStartRequestEvent;
import com.augmentos.augmentoslib.events.ScrollingTextViewStopRequestEvent;
import com.augmentos.augmentoslib.events.SendBitmapViewRequestEvent;
import com.augmentos.augmentoslib.events.StartAsrStreamRequestEvent;
import com.augmentos.augmentoslib.events.StopAsrStreamRequestEvent;
import com.augmentos.augmentoslib.events.SubscribeDataStreamRequestEvent;
import com.augmentos.augmentoslib.events.TextLineViewRequestEvent;
import com.augmentos.augmentoslib.events.TextWallViewRequestEvent;
import com.augmentos.augmentos_core.events.ThirdPartyEdgeAppErrorEvent;
import com.augmentos.augmentos_core.tpa.eventbusmessages.TPARequestEvent;

import org.greenrobot.eventbus.EventBus;

import java.io.Serializable;

public class AugmentOSLibBroadcastReceiver extends BroadcastReceiver {
    private String filterPkg;
    private Context context;
    public String TAG = "WearableAi_AugmentOSLibBroadcastReceiver";

    public AugmentOSLibBroadcastReceiver() {

    }

    public AugmentOSLibBroadcastReceiver(Context context) {
        this.context = context;
        this.filterPkg = AugmentOSGlobalConstants.FROM_TPA_FILTER;
        IntentFilter intentFilter = new IntentFilter(this.filterPkg);
        // Add RECEIVER_EXPORTED flag for Android 13+ compatibility
        context.registerReceiver(this, intentFilter, Context.RECEIVER_EXPORTED);
    }

    public void onReceive(Context context, Intent intent) {
        String eventId = intent.getStringExtra(EVENT_ID);
        String sendingPackage = intent.getStringExtra(APP_PKG_NAME);
        Serializable serializedEvent;
        try {
            serializedEvent = intent.getSerializableExtra(EVENT_BUNDLE);
//        Log.d(TAG, "GOT EVENT ID: " + eventId);
        } catch (Exception e) {
            Log.d(TAG, "ERROR: TPA BUILT FOR INCOMPATIBLE AUGMENTOSLIB VERSION");
            Log.d(TAG, "THE OFFENDING PACKAGE: " + sendingPackage);
            Log.d(TAG, e.getMessage());
            EventBus.getDefault().post(new ThirdPartyEdgeAppErrorEvent(sendingPackage, sendingPackage + " is not compatible with your version of AugmentOS. Please update or uninstall the app."));
            return;
        }

        //map from id to event
        switch (eventId) {
            //if it's a request to run something on glasses or anything else having to do with commands, pipe this through the command system
            case RegisterCommandRequestEvent.eventId:
            case RegisterTpaRequestEvent.eventId:
            case ReferenceCardSimpleViewRequestEvent.eventId:
            case ReferenceCardImageViewRequestEvent.eventId:
            case BulletPointListViewRequestEvent.eventId:
            case ScrollingTextViewStartRequestEvent.eventId:
            case ScrollingTextViewStopRequestEvent.eventId:
            case FinalScrollingTextRequestEvent.eventId:
            case TextLineViewRequestEvent.eventId:
            case FocusRequestEvent.eventId:
            case TextWallViewRequestEvent.eventId:
            case DoubleTextWallViewRequestEvent.eventId:
            case RowsCardViewRequestEvent.eventId:
            case SendBitmapViewRequestEvent.eventId:
            case HomeScreenEvent.eventId:
            case DisplayCustomContentRequestEvent.eventId:
            case StartAsrStreamRequestEvent.eventId:
            case StopAsrStreamRequestEvent.eventId:
//                Log.d(TAG, "Piping command event to ThirdPartyAppSystem for verification before broadcast.");
                EventBus.getDefault().post(new TPARequestEvent(eventId, serializedEvent, sendingPackage));
                break;
            case SubscribeDataStreamRequestEvent.eventId:
                Log.d(TAG, "Resending subscribe to data stream request event");
                EventBus.getDefault().post((SubscribeDataStreamRequestEvent) serializedEvent);
                break;
            case ManagerToCoreRequestEvent.eventId:
//                Log.d(TAG, "Got a manager to core request event");
                if(sendingPackage != null && sendingPackage.equals(AugmentOSManagerPackageName)){
                //    Log.d(TAG, "Got a command from AugmentOS_Manager");
                    EventBus.getDefault().post((ManagerToCoreRequestEvent) serializedEvent);
                }
                else {
                    Log.d(TAG, "Unauthorized package tried to send ManagerToCoreRequest: " + sendingPackage);
                }
        }
    }

    public void unregister(){
       context.unregisterReceiver(this);
    }
}

