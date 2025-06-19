package com.mentra.mentraoslib.provider;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.ProviderInfo;
import android.content.UriMatcher;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.util.List;
import java.util.Scanner;

public class AugmentOSConfigProvider extends ContentProvider {

    private static final String TAG = "AugmentOSConfigProvider";
    private static final int MATCH_CONFIG = 1;
    private static final int MATCH_CONFIG_KEY = 2;
    private static final String[] CURSOR_COLUMNS = {"json"};

    private UriMatcher uriMatcher;

    @Override
    public boolean onCreate() {
        String authority = getAuthority();
        if (authority == null) {
            Log.e(TAG, "No authority found for AugmentOSConfigProvider!");
            return false;
        }

        uriMatcher = new UriMatcher(UriMatcher.NO_MATCH);
        // "content://<authority>/config" => MATCH_CONFIG
        uriMatcher.addURI(authority, "config", MATCH_CONFIG);
        // "content://<authority>/config/*" => MATCH_CONFIG_KEY
        uriMatcher.addURI(authority, "config/*", MATCH_CONFIG_KEY);

        Log.d(TAG, "AugmentOSConfigProvider created with authority: " + authority);
        return true;
    }

    /**
     * Dynamically determine the authority (which includes package name),
     * matching the placeholder in the library's manifest.
     */
    private String getAuthority() {
        if (getContext() == null) return null;

        ProviderInfo info = getContext().getPackageManager().resolveContentProvider(
                getContext().getPackageName() + ".augmentosconfigprovider", 0
        );
        if (info != null) {
            return info.authority;
        }
        return null;
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection,
                        String[] selectionArgs, String sortOrder) {

        if (uriMatcher == null) {
            return null;
        }

        int match = uriMatcher.match(uri);
        if (match == MATCH_CONFIG) {
            return getMergedConfigCursor();
        }
        return null;
    }

    /**
     * Build a cursor that returns a single row with the merged JSON in column "json".
     */
    private Cursor getMergedConfigCursor() {
        MatrixCursor cursor = new MatrixCursor(CURSOR_COLUMNS);
        String mergedJson = buildMergedSettingsJson();
        if (mergedJson != null) {
            cursor.addRow(new Object[]{mergedJson});
        }
        return cursor;
    }

    /**
     * 1) Load tpa_config.json (defaults)
     * 2) Parse it
     * 3) For each setting with a 'key', read the current user value from SharedPreferences
     * 4) Insert that user value into the JSON under a field like "currentValue"
     * 5) Return the combined JSON as a string
     */
    private String buildMergedSettingsJson() {
        try {
            JSONObject rootJson = loadRawConfigAsJson();
            if (rootJson == null) {
                return null;
            }

            JSONArray settingsArr = rootJson.optJSONArray("settings");
            if (settingsArr == null) {
                Log.w(TAG, "No 'settings' array in config!");
                return rootJson.toString();
            }

            // Read from TPA's SharedPreferences
            SharedPreferences prefs = getContext().getSharedPreferences("augmentos_prefs", Context.MODE_PRIVATE);

            // For each setting item
            for (int i = 0; i < settingsArr.length(); i++) {
                JSONObject settingItem = settingsArr.getJSONObject(i);

                // Skip if no "key" or if it's a "group" or "titleValue"
                if (!settingItem.has("key")) {
                    continue;
                }
                String type = settingItem.optString("type", "");
                if ("group".equals(type) || "titleValue".equals(type)) {
                    continue;
                }

                String key = settingItem.getString("key");

                if (prefs.contains(key)) {
                    Object currentVal = getCurrentValueFromPrefs(prefs, key, type, settingItem);
                    settingItem.put("currentValue", currentVal);
                } else {
                    // Fallback to default
                    Object defVal = settingItem.opt("defaultValue");
                    settingItem.put("currentValue", defVal);
                }
            }

            return rootJson.toString();

        } catch (Exception e) {
            Log.e(TAG, "Error building merged settings JSON", e);
            return null;
        }
    }

    /**
     * Reads from SharedPreferences depending on the 'type'.
     */
    private Object getCurrentValueFromPrefs(SharedPreferences prefs, String key,
                                            String type, JSONObject item) {
        try {
            switch (type) {
                case "toggle":
                    return prefs.getBoolean(key, false);

                case "slider": {
                    int storedVal = prefs.getInt(key, 0);
                    // Optional clamping
                    Integer minVal = item.has("min") ? item.getInt("min") : null;
                    Integer maxVal = item.has("max") ? item.getInt("max") : null;
                    if (minVal != null && storedVal < minVal) {
                        storedVal = minVal;
                    }
                    if (maxVal != null && storedVal > maxVal) {
                        storedVal = maxVal;
                    }
                    return storedVal;
                }

                case "multiselect": {
                    String storedArrStr = prefs.getString(key, "[]");
                    return new JSONArray(storedArrStr);
                }

                case "text":
                case "select":
                    return prefs.getString(key, "");

                default:
                    return prefs.getString(key, "");
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to read currentValue for type=" + type + " key=" + key, e);
            return null;
        }
    }

    /**
     * Loads "tpa_config.json" from res/raw and parses it into a JSONObject.
     */
    private JSONObject loadRawConfigAsJson() {
        try {
            Context ctx = getContext();
            if (ctx == null) return null;

            int resId = ctx.getResources().getIdentifier("tpa_config", "raw", ctx.getPackageName());
            if (resId == 0) {
                Log.e(TAG, "No 'tpa_config.json' found in res/raw!");
                return null;
            }
            InputStream inputStream = ctx.getResources().openRawResource(resId);
            if (inputStream == null) return null;

            Scanner scanner = new Scanner(inputStream).useDelimiter("\\A");
            String jsonString = scanner.hasNext() ? scanner.next() : "";
            inputStream.close();

            return new JSONObject(jsonString);

        } catch (Exception e) {
            Log.e(TAG, "Failed to parse tpa_config.json from raw", e);
            return null;
        }
    }

    // --------------------------------------------------------------------
    // WRITE OPERATIONS
    // --------------------------------------------------------------------

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        if (uriMatcher == null) {
            return 0;
        }

        int match = uriMatcher.match(uri);
        if (match == MATCH_CONFIG_KEY) {
            String key = uri.getLastPathSegment();
            return updateSetting(key, values);
        }

        return 0;
    }

    /**
     * Updates a specific setting in SharedPreferences.
     *
     * @param key    The setting key to update.
     * @param values The new values, expecting "currentValue" key.
     * @return The number of settings updated (1 if successful, 0 otherwise).
     */
    private int updateSetting(String key, ContentValues values) {
        if (values == null || !values.containsKey("currentValue")) {
            return 0;
        }

        Object newValue = values.get("currentValue");
        String type = getSettingType(key);
        if (type == null) {
            Log.e(TAG, "Attempted to update unknown key: " + key);
            return 0;
        }

        SharedPreferences prefs = getContext().getSharedPreferences("augmentos_prefs", Context.MODE_PRIVATE);
        SharedPreferences.Editor editor = prefs.edit();

        try {
            switch (type) {
                case "toggle":
                    if (newValue instanceof Boolean) {
                        editor.putBoolean(key, (Boolean) newValue);
                    } else {
                        Log.e(TAG, "Invalid type for toggle: " + newValue);
                        return 0;
                    }
                    break;

                case "slider":
                    if (newValue instanceof Number) {
                        // Optionally, clamp to min/max
                        int val = ((Number) newValue).intValue();
                        JSONObject settingItem = getSettingItem(key);
                        if (settingItem != null) {
                            Integer minVal = settingItem.has("min") ? settingItem.getInt("min") : null;
                            Integer maxVal = settingItem.has("max") ? settingItem.getInt("max") : null;
                            if (minVal != null && val < minVal) val = minVal;
                            if (maxVal != null && val > maxVal) val = maxVal;
                            editor.putInt(key, val);
                        } else {
                            editor.putInt(key, val);
                        }
                    } else {
                        Log.e(TAG, "Invalid type for slider: " + newValue);
                        return 0;
                    }
                    break;

                case "multiselect":
                    if (newValue instanceof JSONArray) {
                        editor.putString(key, newValue.toString());
                    } else if (newValue instanceof List<?>) {
                        JSONArray jsonArray = new JSONArray();
                        for (Object obj : (List<?>) newValue) {
                            jsonArray.put(obj.toString());
                        }
                        editor.putString(key, jsonArray.toString());
                    } else if (newValue instanceof String) {
                        try {
                            // Validate if the string is a valid JSON array
                            new JSONArray((String) newValue);
                            editor.putString(key, (String) newValue);
                            Log.d(TAG, "Updated multiselect '" + key + "' to " + newValue);
                        } catch (Exception e) {
                            Log.e(TAG, "Invalid JSON array string for multiselect: " + newValue, e);
                            return 0;
                        }
                    } else {
                        Log.e(TAG, "Invalid type for multiselect: " + newValue);
                        return 0;
                    }
                    break;

                case "text":
                case "select":
                    if (newValue instanceof String) {
                        editor.putString(key, (String) newValue);
                    } else {
                        Log.e(TAG, "Invalid type for text/select: " + newValue);
                        return 0;
                    }
                    break;

                default:
                    Log.e(TAG, "Unsupported type for update: " + type);
                    return 0;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error updating setting: " + key, e);
            return 0;
        }

        editor.apply();
        return 1; // Successfully updated one setting
    }

    /**
     * Retrieves the type of a given setting key from tpa_config.json.
     *
     * @param key The setting key.
     * @return The type of the setting, or null if not found.
     */
    private String getSettingType(String key) {
        try {
            JSONObject root = loadRawConfigAsJson();
            if (root == null) return null;

            JSONArray settingsArr = root.optJSONArray("settings");
            if (settingsArr == null) return null;

            for (int i = 0; i < settingsArr.length(); i++) {
                JSONObject item = settingsArr.getJSONObject(i);
                if (key.equals(item.optString("key"))) {
                    return item.optString("type");
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "Error retrieving setting type for key: " + key, e);
        }
        return null;
    }

    /**
     * Retrieves the entire setting item JSONObject from tpa_config.json.
     *
     * @param key The setting key.
     * @return The JSONObject representing the setting, or null if not found.
     */
    private JSONObject getSettingItem(String key) {
        try {
            JSONObject root = loadRawConfigAsJson();
            if (root == null) return null;

            JSONArray settingsArr = root.optJSONArray("settings");
            if (settingsArr == null) return null;

            for (int i = 0; i < settingsArr.length(); i++) {
                JSONObject item = settingsArr.getJSONObject(i);
                if (key.equals(item.optString("key"))) {
                    return item;
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "Error retrieving setting item for key: " + key, e);
        }
        return null;
    }

    // --------------------------------------------------------------------
    // REQUIRED OVERRIDES FOR READ-ONLY PROVIDER
    // --------------------------------------------------------------------
    @Override
    public String getType(Uri uri) {
        return null;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        // Not supported
        return null;
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        // Not supported
        return 0;
    }
}
