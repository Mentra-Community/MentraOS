package com.augmentos.augmentos_core.smarterglassesmanager.utils;

import android.content.Context;
import java.io.InputStream;
import java.util.Properties;

public class EnvHelper {
    private static Properties properties = new Properties();

    public static void init(Context context) {
        try (InputStream input = context.getAssets().open("env")) {
            properties.load(input);
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    public static String getEnv(String key) {
        return properties.getProperty(key);
    }
}
