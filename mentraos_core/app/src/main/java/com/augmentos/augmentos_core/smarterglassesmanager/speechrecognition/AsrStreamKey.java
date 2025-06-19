package com.augmentos.augmentos_core.smarterglassesmanager.speechrecognition;

import androidx.annotation.NonNull;

import com.mentra.mentraoslib.enums.AsrStreamType;

import java.util.Objects;

public class AsrStreamKey {
    public final AsrStreamType streamType;
    public final String transcribeLanguage;
    public final String translateLanguage;

    public AsrStreamKey(String transcribeLanguage) {
        this.streamType = AsrStreamType.TRANSCRIPTION;
        this.transcribeLanguage = transcribeLanguage;
        this.translateLanguage = null;
    }

    public AsrStreamKey(String transcribeLanguage, String translateLanguage) {
        this.streamType = AsrStreamType.TRANSLATION;
        this.transcribeLanguage = transcribeLanguage;
        this.translateLanguage = translateLanguage;
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (o == null || getClass() != o.getClass()) return false;
        AsrStreamKey that = (AsrStreamKey) o;
        return streamType == that.streamType &&
                Objects.equals(transcribeLanguage, that.transcribeLanguage) &&
                Objects.equals(translateLanguage, that.translateLanguage);
    }

    @Override
    public int hashCode() {
        return Objects.hash(streamType, transcribeLanguage, translateLanguage);
    }

    @NonNull
    @Override
    public String toString() {
        if (streamType == AsrStreamType.TRANSCRIPTION) {
            return "TRANSCRIPTION_" + transcribeLanguage;
        } else {
            return "TRANSLATION_" + transcribeLanguage + "_TO_" + translateLanguage;
        }
    }
}
