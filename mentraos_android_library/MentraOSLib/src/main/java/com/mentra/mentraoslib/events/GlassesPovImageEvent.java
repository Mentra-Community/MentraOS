package com.mentra.mentraoslib.events;

public class GlassesPovImageEvent {
    public String encodedImgString;
    public long imageTime;
    public static final String eventId = "glassesPovImageEvent";

    public GlassesPovImageEvent(String encodedImgString, long imageTime){
        this.encodedImgString = encodedImgString;
        this.imageTime = imageTime;
    }
}
