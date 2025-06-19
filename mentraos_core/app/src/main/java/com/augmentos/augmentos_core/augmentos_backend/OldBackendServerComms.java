package com.augmentos.augmentos_core.augmentos_backend;

/*
Adapted from:
https://github.com/emexlabs/WearableIntelligenceSystem/blob/master/android_smart_phone/main/app/src/main/java/com/wearableintelligencesystem/androidsmartphone/comms/BackendServerComms.java
 */

import static com.augmentos.augmentos_core.Constants.BUTTON_EVENT_ENDPOINT;
import static com.augmentos.augmentos_core.Constants.GET_USER_SETTINGS_ENDPOINT;
import static com.augmentos.augmentos_core.Constants.LLM_QUERY_ENDPOINT;
import static com.augmentos.augmentos_core.Constants.REQUEST_APP_BY_PACKAGE_NAME_DOWNLOAD_LINK_ENDPOINT;
import static com.augmentos.augmentos_core.Constants.SEND_NOTIFICATIONS_ENDPOINT;
import static com.augmentos.augmentos_core.Constants.SET_USER_SETTINGS_ENDPOINT;
import static com.augmentos.augmentos_core.Constants.UI_POLL_ENDPOINT;
import static com.augmentos.augmentos_core.augmentos_backend.Config.devServerUrl;
import static com.augmentos.augmentos_core.augmentos_backend.Config.serverUrl;
import static com.augmentos.augmentos_core.augmentos_backend.Config.useDevServer;

import android.content.Context;
import android.util.Log;

import com.android.volley.DefaultRetryPolicy;
import com.android.volley.Request;
import com.android.volley.RequestQueue;
import com.android.volley.Response;
import com.android.volley.VolleyError;
import com.android.volley.toolbox.JsonObjectRequest;
import com.android.volley.toolbox.Volley;
import org.json.JSONObject;
import org.json.JSONException;

import java.util.Objects;

public class OldBackendServerComms {
    private static final String TAG = "MXT2_BackendServerComms";

    private static OldBackendServerComms restServerComms;

    // Volley variables
    private final RequestQueue mRequestQueue;
    private final Context mContext;
    private final int requestTimeoutPeriod = 0; // Adjust as needed

    // Singleton pattern to get the instance
    public static OldBackendServerComms getInstance(Context c){
        if (restServerComms == null){
            restServerComms = new OldBackendServerComms(c.getApplicationContext());
        }
        return restServerComms;
    }

    private OldBackendServerComms(Context context) {
        mContext = context;
        mRequestQueue = Volley.newRequestQueue(mContext);
    }

    public void restRequest(String endpoint, JSONObject data, VolleyJsonCallback callback) throws JSONException {
        // Build the URL
        String builtUrl = serverUrl;
        if (useDevServer) {
            builtUrl += devServerUrl;
        }
        builtUrl += endpoint;

        int requestType = (data == null) ? Request.Method.GET : Request.Method.POST;

        JsonObjectRequest request = new JsonObjectRequest(requestType, builtUrl, data,
                new Response.Listener<JSONObject>() {
                    @Override
                    public void onResponse(JSONObject response) {
                        try {
                            if (Objects.equals(endpoint, UI_POLL_ENDPOINT) || Objects.equals(endpoint, REQUEST_APP_BY_PACKAGE_NAME_DOWNLOAD_LINK_ENDPOINT) || Objects.equals(endpoint, SEND_NOTIFICATIONS_ENDPOINT)) {
                                if (response.getBoolean("success")) {
                                    callback.onSuccess(response);
                                } else {
                                    callback.onFailure(-1);
                                }
                            } else if (Objects.equals(endpoint, LLM_QUERY_ENDPOINT) || Objects.equals(endpoint, BUTTON_EVENT_ENDPOINT) || Objects.equals(endpoint, SET_USER_SETTINGS_ENDPOINT) || Objects.equals(endpoint, GET_USER_SETTINGS_ENDPOINT)) {
                                if (response.has("message")) {
                                    callback.onSuccess(response);
                                } else {
                                    callback.onFailure(-1);
                                }
                            } else {
                                // Handle other endpoints if necessary
                                Log.e(TAG, "Unhandled endpoint response" + endpoint);
                                callback.onFailure(-1);
                            }
                        } catch (JSONException e) {
                            Log.e(TAG, "JSON parsing error: ", e);
                            callback.onFailure(-1);
                        }
                    }
                },
                new Response.ErrorListener() {
                    @Override
                    public void onErrorResponse(VolleyError error) {
                        Log.e(TAG, "Failure sending data.", error);
                        callback.onFailure(-1);
                    }
                });

        // Set the retry policy
        request.setRetryPolicy(new DefaultRetryPolicy(
                requestTimeoutPeriod,
                0,
                DefaultRetryPolicy.DEFAULT_BACKOFF_MULT));

        // Add the request to the RequestQueue
        mRequestQueue.add(request);
    }
}