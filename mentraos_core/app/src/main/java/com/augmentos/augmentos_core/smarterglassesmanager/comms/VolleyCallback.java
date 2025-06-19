package com.augmentos.augmentos_core.smarterglassesmanager.comms;

import org.json.JSONObject;

public interface VolleyCallback {
    void onSuccess(JSONObject result);
    void onFailure();
}
