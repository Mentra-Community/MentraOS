package com.mentra.mentraoslib;


public class PhoneNotification {
    private String title;
    private String message;
    private String appName;
    private long timestamp;
    private String uuid;

    public PhoneNotification(String title, String message, String appName, long timestamp, String uuid) {
        this.title = title;
        this.message = message;
        this.appName = appName;
        this.timestamp = timestamp;
        this.uuid = uuid;
    }

    public String getTitle() {
        return title;
    }

    public String getText() {
        return message;
    }

    public String getAppName() {
        return appName;
    }

    public long getTimestamp() {
        return timestamp;
    }

    public String getUuid() {
        return uuid;
    }

    public void setUuid(String uuid) {
        this.uuid = uuid;
    }

    @Override
    public String toString() {
        return String.format("Notification{title='%s', text='%s', appName='%s', uuid='%s'}",
                title, message, appName, uuid);
    }
}