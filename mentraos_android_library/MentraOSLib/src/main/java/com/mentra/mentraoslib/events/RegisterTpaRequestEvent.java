package com.mentra.mentraoslib.events;

import com.mentra.mentraoslib.ThirdPartyEdgeApp;

import java.io.Serializable;

public class RegisterTpaRequestEvent implements Serializable {
    public ThirdPartyEdgeApp thirdPartyEdgeApp;
    public static final String eventId = "registerTpaRequestEvent";

    public RegisterTpaRequestEvent(ThirdPartyEdgeApp thirdPartyEdgeApp){
        this.thirdPartyEdgeApp = thirdPartyEdgeApp;
    }

    public static String getEventId(){
        return("registerCommandRequestEvent");
    }
}
