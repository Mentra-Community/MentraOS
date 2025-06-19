package com.mentra.mentraoslib;

public class AugmentOSCommandWithCallback {
    public AugmentOSCommand command;
    public AugmentOSCallback callback;

    public AugmentOSCommandWithCallback(AugmentOSCommand command, AugmentOSCallback callback){
        this.command = command;
        this.callback = callback;
    }
}
