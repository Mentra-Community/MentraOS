package com.mentra.mentraoslib;

import static com.mentra.mentraoslib.AugmentOSGlobalConstants.APP_PKG_NAME;
import static com.mentra.mentraoslib.AugmentOSGlobalConstants.EVENT_BUNDLE;
import static com.mentra.mentraoslib.AugmentOSGlobalConstants.EVENT_ID;

import android.content.Context;
import android.content.Intent;
import android.util.Log;

import com.mentra.mentraoslib.events.BulletPointListViewRequestEvent;
import com.mentra.mentraoslib.events.DoubleTextWallViewRequestEvent;
import com.mentra.mentraoslib.events.FinalScrollingTextRequestEvent;
import com.mentra.mentraoslib.events.FocusRequestEvent;
import com.mentra.mentraoslib.events.HomeScreenEvent;
import com.mentra.mentraoslib.events.ManagerToCoreRequestEvent;
import com.mentra.mentraoslib.events.ReferenceCardImageViewRequestEvent;
import com.mentra.mentraoslib.events.ReferenceCardSimpleViewRequestEvent;
import com.mentra.mentraoslib.events.RegisterCommandRequestEvent;
import com.mentra.mentraoslib.events.RegisterTpaRequestEvent;
import com.mentra.mentraoslib.events.RowsCardViewRequestEvent;
import com.mentra.mentraoslib.events.ScrollingTextViewStartRequestEvent;
import com.mentra.mentraoslib.events.ScrollingTextViewStopRequestEvent;
import com.mentra.mentraoslib.events.SendBitmapViewRequestEvent;
import com.mentra.mentraoslib.events.StartAsrStreamRequestEvent;
import com.mentra.mentraoslib.events.StopAsrStreamRequestEvent;
import com.mentra.mentraoslib.events.SubscribeDataStreamRequestEvent;
import com.mentra.mentraoslib.events.TextLineViewRequestEvent;
import com.mentra.mentraoslib.events.TextWallViewRequestEvent;

import org.greenrobot.eventbus.Subscribe;

import java.io.Serializable;

public class TPABroadcastSender {
    private String intentPkg;
    private String packageName;
    Context context;

    public TPABroadcastSender(Context context) {
        this.context = context;
        this.intentPkg = AugmentOSGlobalConstants.FROM_TPA_FILTER;
        packageName = context.getPackageName();

        //register event bus subscribers
        AugmentOSLibBus.getInstance().register(this);
    }

    public void sendEventToAugmentOS(String eventId, Serializable eventBundle) {
//        Log.d("TPASEND event: ", this.intentPkg);

        //setup intent to send
        Intent intent = new Intent();
        intent.setAction(intentPkg);
        intent.setFlags(Intent.FLAG_INCLUDE_STOPPED_PACKAGES);

        //load in and send data
        intent.putExtra(EVENT_ID, eventId);
        intent.putExtra(APP_PKG_NAME, packageName);
        intent.putExtra(EVENT_BUNDLE, eventBundle);
        context.sendBroadcast(intent);
    }

    @Subscribe
    public void onStartAsrStreamRequestEvent(StartAsrStreamRequestEvent receivedEvent){
        String eventId = StartAsrStreamRequestEvent.eventId;
        sendEventToAugmentOS(eventId, receivedEvent);
    }

    @Subscribe
    public void onStopAsrStreamRequestEvent(StopAsrStreamRequestEvent receivedEvent){
        String eventId = StopAsrStreamRequestEvent.eventId;
        sendEventToAugmentOS(eventId, receivedEvent);
    }

    @Subscribe
    public void onReferenceCardSimpleViewEvent(ReferenceCardSimpleViewRequestEvent receivedEvent){
        String eventId = receivedEvent.eventId;
        sendEventToAugmentOS(eventId, receivedEvent);
    }

    @Subscribe
    public void onReferenceCardImageViewEvent(ReferenceCardImageViewRequestEvent receivedEvent){
        String eventId = receivedEvent.eventId;
        sendEventToAugmentOS(eventId, receivedEvent);
    }

    @Subscribe
    public void onBulletPointListViewEvent(BulletPointListViewRequestEvent receivedEvent){
        String eventId = receivedEvent.eventId;
        sendEventToAugmentOS(eventId, receivedEvent);
    }

    @Subscribe
    public void onTextLineViewEvent(TextLineViewRequestEvent receivedEvent){
        String eventId = receivedEvent.eventId;
        sendEventToAugmentOS(eventId, receivedEvent);
    }

    @Subscribe
    public void onStartScrollingTextEvent(ScrollingTextViewStartRequestEvent receivedEvent){
        String eventId = receivedEvent.eventId;
        sendEventToAugmentOS(eventId, receivedEvent);
    }

    @Subscribe
    public void onSendTextWall(TextWallViewRequestEvent receivedEvent){
        sendEventToAugmentOS(receivedEvent.eventId, receivedEvent);
    }

    @Subscribe
    public void onSendDoubleTextWall(DoubleTextWallViewRequestEvent e){
        sendEventToAugmentOS(e.eventId, e);
    }

    @Subscribe
    public void onSendSubscribeDataStream(SubscribeDataStreamRequestEvent e){
        sendEventToAugmentOS(e.eventId, e);
    }

    @Subscribe
    public void onSendRowsCard(RowsCardViewRequestEvent e){
        sendEventToAugmentOS(e.eventId, e);
    }

    @Subscribe
    public void onSendBitmap(SendBitmapViewRequestEvent e){
        sendEventToAugmentOS(e.eventId, e);
    }

    @Subscribe
    public void onSendDataFromManagerToCore(ManagerToCoreRequestEvent e){
        sendEventToAugmentOS(e.eventId, e);
    }

    @Subscribe
    public void onSendHomeScreen(HomeScreenEvent e){
        sendEventToAugmentOS(e.eventId, e);
    }

    @Subscribe
    public void onFinalScrollingTextEvent(FinalScrollingTextRequestEvent receivedEvent){
        Log.d("TPASEND", "FINAL SCROLL SEND");
        String eventId = receivedEvent.eventId;
        sendEventToAugmentOS(eventId, receivedEvent);
    }
    public void onScrollingTextViewStopEvent(ScrollingTextViewStopRequestEvent receivedEvent){
        String eventId = receivedEvent.eventId;
        sendEventToAugmentOS(eventId, receivedEvent);
    }

    @Subscribe
    public void onRegisterCommandRequestEvent(RegisterCommandRequestEvent receivedEvent){
        String eventId = receivedEvent.getEventId();
        sendEventToAugmentOS(eventId, receivedEvent);
    }

    @Subscribe
    public void onRegisterAppRequestEvent(RegisterTpaRequestEvent e){
        sendEventToAugmentOS(e.eventId, e);
    }

    @Subscribe
    public void onFocusRequestEvent(FocusRequestEvent receivedEvent){
        String eventId = receivedEvent.eventId;
        sendEventToAugmentOS(eventId, receivedEvent);
    }

    public void destroy(){
        //unregister event bus subscribers
        AugmentOSLibBus.getInstance().unregister(this);
    }
}