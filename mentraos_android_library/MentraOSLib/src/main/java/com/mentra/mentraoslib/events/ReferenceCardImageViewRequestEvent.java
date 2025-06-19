package com.mentra.mentraoslib.events;

import java.io.Serializable;

public class ReferenceCardImageViewRequestEvent implements Serializable {
    public String title;
    public String body;
    public String imgUrl;
    public static final String eventId = "referenceCardImageViewRequestEvent";

    public ReferenceCardImageViewRequestEvent(String title, String body, String imgUrl) {
        this.title = title;
        this.body = body;
        this.imgUrl = imgUrl;
    }
}
