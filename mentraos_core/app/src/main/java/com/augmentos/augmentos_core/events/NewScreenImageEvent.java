package com.augmentos.augmentos_core.events;

import android.graphics.Bitmap;

public class NewScreenImageEvent {
    public Bitmap bmp;

    public NewScreenImageEvent(Bitmap newBmp){
        bmp = newBmp;
    }
}
