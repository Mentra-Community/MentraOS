package com.mentra.mentraoslib;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Scanner;

/**
 * Example manager to parse tpa_config.json and provide typed getters and setters
 * for toggle, text, slider, select, multiselect, etc.
 */
public class AugmentOSSettingsManager {
    private static final String TAG = "AugmentOSSettingsManager";

    private static final String PREFS_NAME = "augmentos_prefs";
    private static volatile boolean configLoaded = false;

    /**
     * We will store parsed settings in this list. We only care about items that
     * have a "key" (toggles, text, slider, select, multiselect, etc.).
     */
    private static List<SettingDef> settingDefs = new ArrayList<>();

    //--------------------------------------------------------------------------
    // INTERNAL MODEL
    //--------------------------------------------------------------------------

    private static class SettingDef {
        String key;            // e.g. "enableLogging"
        String type;           // e.g. "toggle", "text", "slider", "select", "multiselect", "titleValue", "group"
        Object defaultValue;   // bool, string, int, or array for multiselect
        Integer min;           // only for slider
        Integer max;           // only for slider
        // You could store "options" for select/multiselect, but we only need
        // them for UI rendering, not necessarily for storing the user's choice.

        SettingDef(String key, String type, Object defaultValue, Integer min, Integer max) {
            this.key = key;
            this.type = type;
            this.defaultValue = defaultValue;
            this.min = min;
            this.max = max;
        }
    }

    //--------------------------------------------------------------------------
    // PUBLIC GETTERS / SETTERS
    //--------------------------------------------------------------------------
    // 1) Toggle
    public static boolean getBooleanSetting(Context context, String key) {
        ensureConfigLoaded(context);
        Object defVal = findDefaultValue(key);
        boolean defaultVal = (defVal instanceof Boolean) ? (Boolean) defVal : false;

        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        if (!prefs.contains(key)) {
            return defaultVal;
        }
        return prefs.getBoolean(key, defaultVal);
    }

    public static void setBooleanSetting(Context context, String key, boolean value) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        prefs.edit().putBoolean(key, value).apply();
    }

    // 2) Text
    public static String getStringSetting(Context context, String key) {
        ensureConfigLoaded(context);
        Object defVal = findDefaultValue(key);
        String defaultVal = (defVal instanceof String) ? (String) defVal : "";

        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        if (!prefs.contains(key)) {
            return defaultVal;
        }
        return prefs.getString(key, defaultVal);
    }

    public static void setStringSetting(Context context, String key, String value) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        prefs.edit().putString(key, value).apply();
    }

    // 3) Slider (int)
    // We assume volumeLevel or something is an integer. If you wanted float, adapt accordingly.
    public static int getSliderSetting(Context context, String key) {
        ensureConfigLoaded(context);
        Object defVal = findDefaultValue(key);
        int defaultVal = (defVal instanceof Number) ? ((Number) defVal).intValue() : 0;

        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        if (!prefs.contains(key)) {
            return defaultVal;
        }
        return prefs.getInt(key, defaultVal);
    }

    public static void setSliderSetting(Context context, String key, int value) {
        // Optionally, you could clamp to min and max here
        ensureConfigLoaded(context);
        SettingDef def = findSettingDef(key);
        if (def != null) {
            if (def.min != null && value < def.min) {
                value = def.min;
            }
            if (def.max != null && value > def.max) {
                value = def.max;
            }
        }
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        prefs.edit().putInt(key, value).apply();
    }

    // 4) Single Select (e.g. colorScheme)
    // We'll store it as a String in SharedPrefs, referencing the "value" of the selected option.
    public static String getSelectSetting(Context context, String key) {
        ensureConfigLoaded(context);
        Object defVal = findDefaultValue(key);
        String defaultVal = (defVal instanceof String) ? (String) defVal : "";

        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        if (!prefs.contains(key)) {
            return defaultVal;
        }
        return prefs.getString(key, defaultVal);
    }

    public static void setSelectSetting(Context context, String key, String value) {
        // You could optionally validate "value" is in the options array if you want
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        prefs.edit().putString(key, value).apply();
    }

    // 5) Multi Select (store as JSON array in SharedPrefs)
    // For example, defaultValue might be ["red", "blue"].
    public static List<String> getMultiSelectSetting(Context context, String key) {
        ensureConfigLoaded(context);
        // Grab default, which might be a List or JSONArray
        Object defVal = findDefaultValue(key);

        List<String> defaultList = new ArrayList<>();
        if (defVal instanceof JSONArray) {
            // parse from JSON array
            JSONArray arr = (JSONArray) defVal;
            for (int i = 0; i < arr.length(); i++) {
                defaultList.add(arr.optString(i));
            }
        } else if (defVal instanceof List) {
            // if we had cast it to a list earlier
            @SuppressWarnings("unchecked")
            List<String> castList = (List<String>) defVal;
            defaultList = new ArrayList<>(castList);
        }

        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        if (!prefs.contains(key)) {
            // If not in prefs, return the default
            return defaultList;
        }

        String storedJson = prefs.getString(key, "[]");
        return jsonArrayToList(storedJson);
    }

    public static void setMultiSelectSetting(Context context, String key, List<String> values) {
        // Convert the list to a JSON array string
        JSONArray arr = new JSONArray();
        for (String val : values) {
            arr.put(val);
        }
        String jsonStr = arr.toString();

        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        prefs.edit().putString(key, jsonStr).apply();
    }

    //--------------------------------------------------------------------------
    // INTERNAL UTILS
    //--------------------------------------------------------------------------

    /**
     * Convert a JSON array string (e.g. "[\"red\",\"blue\"]") to a List<String>.
     */
    private static List<String> jsonArrayToList(String jsonArrayStr) {
        List<String> result = new ArrayList<>();
        try {
            JSONArray arr = new JSONArray(jsonArrayStr);
            for (int i = 0; i < arr.length(); i++) {
                result.add(arr.getString(i));
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to parse multiSelect JSON array", e);
        }
        return result;
    }

    /**
     * Load and parse the config once, in a thread-safe manner.
     */
    private static void ensureConfigLoaded(Context context) {
        if (!configLoaded) {
            synchronized (AugmentOSSettingsManager.class) {
                if (!configLoaded) {
                    loadConfig(context);
                    configLoaded = true;
                }
            }
        }
    }

    /**
     * Parse the TPA's tpa_config.json. We'll store:
     * - key
     * - type
     * - defaultValue
     * - min, max (for sliders)
     *
     * We ignore "group" and "titleValue" for storing in prefs.
     */
    private static void loadConfig(Context context) {
        settingDefs.clear();
        try {
            int resId = context.getResources().getIdentifier("tpa_config", "raw", context.getPackageName());
            if (resId == 0) {
                Log.w(TAG, "No tpa_config.json found in res/raw!");
                return;
            }

            InputStream inputStream = context.getResources().openRawResource(resId);
            Scanner s = new Scanner(inputStream).useDelimiter("\\A");
            String jsonString = s.hasNext() ? s.next() : "";
            inputStream.close();

            JSONObject root = new JSONObject(jsonString);
            JSONArray settingsArr = root.optJSONArray("settings");
            if (settingsArr == null) {
                Log.w(TAG, "No 'settings' array in tpa_config.json");
                return;
            }

            for (int i = 0; i < settingsArr.length(); i++) {
                JSONObject item = settingsArr.getJSONObject(i);
                String type = item.optString("type", "");

                // Skip groups or titleValue if they have no key or if you don't want to store them
                if ("group".equals(type) || "titleValue".equals(type)) {
                    continue; // not stored in prefs
                }
                if (!item.has("key")) {
                    continue; // no key, can't store
                }

                String key = item.getString("key");
                Object defaultVal = item.opt("defaultValue");

                // For slider, we might parse min/max
                Integer minVal = null;
                Integer maxVal = null;
                if ("slider".equals(type)) {
                    if (item.has("min")) {
                        minVal = item.getInt("min");
                    }
                    if (item.has("max")) {
                        maxVal = item.getInt("max");
                    }
                }

                // If defaultValue is an array for "multiselect", it will come in as a JSONArray
                // We'll just store it as-is in SettingDef.

                // Build a SettingDef
                SettingDef def = new SettingDef(key, type, defaultVal, minVal, maxVal);
                settingDefs.add(def);
            }

            Log.d(TAG, "Loaded " + settingDefs.size() + " storable settings from tpa_config.json");
        } catch (Exception e) {
            Log.e(TAG, "Error parsing tpa_config.json", e);
        }
    }

    /**
     * Get the SettingDef, if any.
     */
    private static SettingDef findSettingDef(String key) {
        for (SettingDef def : settingDefs) {
            if (def.key.equals(key)) {
                return def;
            }
        }
        return null;
    }

    /**
     * Return the defaultValue for the given key, or null if not found.
     */
    private static Object findDefaultValue(String key) {
        SettingDef def = findSettingDef(key);
        return (def != null) ? def.defaultValue : null;
    }
}
