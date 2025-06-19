package com.augmentos.augmentos_core.smarterglassesmanager.smartglassescommunicators;

public class UltraliteLayoutHelper {
//    public static String getJsonTag(Layout layout) {
//        return layout.getJsonTag();
//    }

    public static String getCustomJsonTag(String layout) {
        switch (layout) {
            case "TEXT_TOP_LEFT_ALIGN":
                return "ttla";
            default:
                return "";
        }
    }
}