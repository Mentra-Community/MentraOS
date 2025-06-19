package com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages;


import com.augmentos.augmentos_core.smarterglassesmanager.speechrecognition.AsrStreamKey;

import java.util.List;

public class NewAsrLanguagesEvent {
    public List<AsrStreamKey> languages;

    public NewAsrLanguagesEvent(List<AsrStreamKey> languages){
        this.languages = languages;
    }
}
