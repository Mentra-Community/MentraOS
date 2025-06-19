package com.augmentos.augmentos_core;

import androidx.annotation.NonNull;

public class CalendarItem {
    private final long eventId;
    private final String title;
    private final long dtStart;
    private final long dtEnd;
    private final String timeZone;

    public CalendarItem(long eventId, String title, long dtStart, long dtEnd, String timeZone) {
        this.eventId = eventId;
        this.title = title;
        this.dtStart = dtStart;
        this.dtEnd = dtEnd;
        this.timeZone = timeZone;
    }

    public long getEventId() {
        return eventId;
    }

    public String getTitle() {
        return title;
    }

    public long getDtStart() {
        return dtStart;
    }

    public long getDtEnd() {
        return dtEnd;
    }

    public String getTimeZone() {
        return timeZone;
    }

    @NonNull
    @Override
    public String toString() {
        return "CalendarEvent{" +
                "eventId=" + eventId +
                ", title='" + title + '\'' +
                ", dtStart=" + dtStart +
                ", dtEnd=" + dtEnd +
                ", timeZone='" + timeZone + '\'' +
                '}';
    }
}