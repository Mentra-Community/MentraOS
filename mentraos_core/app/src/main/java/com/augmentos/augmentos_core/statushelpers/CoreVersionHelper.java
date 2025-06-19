package com.augmentos.augmentos_core.statushelpers;

import android.content.Context;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.io.InputStream;
import java.util.Scanner;

public final class CoreVersionHelper {

    private static final String TAG = "CoreVersionHelper";

    // Private constructor to prevent instantiation of this utility class
    private CoreVersionHelper() {
        /* NO-OP */
    }

    /**
     * Reads the "tpa_config.json" file from the app's raw resources
     * and extracts the "version" field.
     *
     * @param context Any valid Android Context (e.g. Activity, Service)
     * @return the version string or "Unknown" if not found
     */
    public static String getCoreVersion(Context context) {
        try {
            // Look up the resource ID for "config" in res/raw
            int resId = context.getResources().getIdentifier("config", "raw", context.getPackageName());
            if (resId == 0) {
                Log.w(TAG, "No tpa_config.json found in res/raw!");
                return "Unknown";
            }

            // Read file contents
            InputStream inputStream = context.getResources().openRawResource(resId);
            Scanner scanner = new Scanner(inputStream).useDelimiter("\\A");
            String jsonString = scanner.hasNext() ? scanner.next() : "";
            inputStream.close();

            // Parse JSON and get the "version" field
            JSONObject root = new JSONObject(jsonString);
            return root.optString("version", "Unknown");

        } catch (IOException e) {
            throw new RuntimeException("Error reading config file", e);
        } catch (JSONException e) {
            throw new RuntimeException("Error parsing JSON", e);
        }
    }
}