package com.mentra.mentraoslib.events;

import com.mentra.mentraoslib.DataStreamType;

import java.io.Serializable;

public class SubscribeDataStreamRequestEvent implements Serializable {
    public DataStreamType dataStreamType;
    public static final String eventId = "subscribeDataStreamRequestEvent";

    public SubscribeDataStreamRequestEvent(DataStreamType dataStreamType){
        this.dataStreamType = dataStreamType;
    }

    public static String getEventId(){
        return("subscribeDataStreamRequestEvent");
    }
}
