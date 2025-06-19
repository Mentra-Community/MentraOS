package com.augmentos.augmentos_core.defaultdashboard;

import com.mentra.mentraoslib.AugmentOSLib;
import com.mentra.mentraoslib.SmartGlassesAndroidService;


public class DefaultDashboardService extends SmartGlassesAndroidService {
    public static final String TAG = "DefaultDashboard";

    // Our instance of the AugmentOS library
    public AugmentOSLib augmentOSLib;

    public DefaultDashboardService() {
        super();
    }

    @Override
    public void onCreate() {
        super.onCreate();
    }

    @Override
    public void setup(){
        // Create AugmentOSLib instance with context: this
        augmentOSLib = new AugmentOSLib(this);
    }
}
