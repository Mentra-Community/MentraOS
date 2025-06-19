package com.mentra.mentraoslib.events;

import com.mentra.mentraoslib.ThirdPartyEdgeApp;

import java.io.Serializable;

public class KillTpaEvent implements Serializable {
    public ThirdPartyEdgeApp tpa;
    public static final String eventId = "killTpaEvent";

    public KillTpaEvent(ThirdPartyEdgeApp tpa){
        this.tpa = tpa;
    }

}
