package com.mentra.mentraoslib.events;

import android.graphics.Bitmap;

import java.io.Serializable;

public class SendBitmapViewRequestEvent implements Serializable {
    public Bitmap bmp;
    public static final String eventId = "sendBitmapViewRequestEvent";


    public SendBitmapViewRequestEvent(Bitmap newBbmp) {
        this.bmp = newBbmp;
    }
}
