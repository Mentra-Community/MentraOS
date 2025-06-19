package com.mentra.mentraoslib.events;

import com.mentra.mentraoslib.AugmentOSCommand;

import java.io.Serializable;

public class CommandTriggeredEvent implements Serializable {
    public AugmentOSCommand command;
    public String args;
    public long commandTriggeredTime;
    public static final String eventId = "commandTriggeredEvent";

    public CommandTriggeredEvent(AugmentOSCommand command, String args, long commandTriggeredTime){
        this.command = command;
        this.args = args;
        this.commandTriggeredTime = commandTriggeredTime;
    }
}
