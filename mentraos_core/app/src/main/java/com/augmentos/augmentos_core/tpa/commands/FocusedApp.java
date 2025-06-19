package com.augmentos.augmentos_core.tpa.commands;

import com.mentra.mentraoslib.FocusStates;

public class FocusedApp {
    public FocusStates focusState;
    public String appPackage;

    public FocusedApp(FocusStates focusState, String appPackage){
        this.focusState = focusState;
        this.appPackage = appPackage;
    }

    public FocusStates getFocusState() {
        return focusState;
    }

    public void setFocusState(FocusStates focusState) {
        this.focusState = focusState;
    }

    public String getAppPackage() {
        return appPackage;
    }

    public void setAppPackage(String appPackage) {
        this.appPackage = appPackage;
    }
}
