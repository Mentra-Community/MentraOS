package com.mentra.mentraoslib.events;

import java.io.Serializable;

public class NotificationEvent implements Serializable {
    public String title;
    public String text;
    public String appName;
    public long timestamp;
    public String uuid;
    public static final String eventId = "notificationEvent";

    public NotificationEvent(String title, String text, String appName, long timestamp, String uuid) {
        this.title = title;
        this.text = text;
        this.appName = appName;
        this.timestamp = timestamp;
        this.uuid = uuid;
    }
}