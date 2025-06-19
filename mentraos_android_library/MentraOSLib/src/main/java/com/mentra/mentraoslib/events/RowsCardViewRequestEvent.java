package com.mentra.mentraoslib.events;

import java.io.Serializable;

public class RowsCardViewRequestEvent implements Serializable {
    public String[] rowStrings;
    public static final String eventId = "rowStringsViewRequestEvent";

    public RowsCardViewRequestEvent(String[] rowStrings) {
        this.rowStrings = rowStrings;
    }
}
