package com.mentra.mentraoslib.events;

import com.mentra.mentraoslib.enums.AsrStreamType;

import java.io.Serializable;

public class StopAsrStreamRequestEvent implements Serializable {
    public String transcribeLanguage;
    public String translateLanguage;
    public final AsrStreamType asrStreamType;
    public String packageName;
    public static final String eventId = "StopAsrStreamRequestEvent";

    public StopAsrStreamRequestEvent(String transcribeLanguage) {
        this.transcribeLanguage = transcribeLanguage;
        this.asrStreamType = AsrStreamType.TRANSCRIPTION;
    }

    public StopAsrStreamRequestEvent(String transcribeLanguage, String translateLanguage) {
        this.transcribeLanguage = transcribeLanguage;
        this.translateLanguage = translateLanguage;
        this.asrStreamType = AsrStreamType.TRANSLATION;
    }

    private StopAsrStreamRequestEvent(
            String transcribeLanguage,
            String translateLanguage,
            AsrStreamType asrStreamType,
            String packageName
    ) {
        this.transcribeLanguage = transcribeLanguage;
        this.translateLanguage = translateLanguage;
        this.asrStreamType = asrStreamType;
        this.packageName = packageName;
    }

    public StopAsrStreamRequestEvent withPackageName(String pkgName) {
        return new StopAsrStreamRequestEvent(
                this.transcribeLanguage,
                this.translateLanguage,
                this.asrStreamType,
                pkgName
        );
    }
}