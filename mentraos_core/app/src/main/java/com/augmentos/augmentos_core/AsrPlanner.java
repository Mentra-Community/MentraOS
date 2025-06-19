package com.augmentos.augmentos_core;

import android.util.Log;

import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.NewAsrLanguagesEvent;
import com.augmentos.augmentos_core.smarterglassesmanager.speechrecognition.AsrStreamKey;
import com.augmentos.augmentos_core.tpa.EdgeTPASystem;
import com.mentra.mentraoslib.enums.AsrStreamType;
import com.mentra.mentraoslib.events.KillTpaEvent;
import com.mentra.mentraoslib.events.SpeechRecOutputEvent;
import com.mentra.mentraoslib.events.StartAsrStreamRequestEvent;
import com.mentra.mentraoslib.events.StopAsrStreamRequestEvent;
import com.mentra.mentraoslib.events.TranslateOutputEvent;

import org.greenrobot.eventbus.EventBus;
import org.greenrobot.eventbus.Subscribe;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

public class AsrPlanner {
    public static final String TAG = "ASRPlanner";
    private final Map<AsrStreamKey, Set<String>> activeStreams = new HashMap<>();
    ArrayList<String> transcriptsBuffer;

    EdgeTPASystem edgeTpaSystem;

    public AsrPlanner(EdgeTPASystem edgeTpaSystemRef){
        this.edgeTpaSystem = edgeTpaSystemRef;

        //make responses holder
        transcriptsBuffer = new ArrayList<>();

        //setup english as an ASR language
        AsrStreamKey enKey = new AsrStreamKey("en-US");
        addAsrStream("AugmentOS_INTERNAL", enKey);
    }

    @Subscribe
    public void onTranscript(SpeechRecOutputEvent event) {
        String text = event.text;
        String languageCode = event.languageCode;
        boolean isFinal = event.isFinal;

        AsrStreamKey streamKey = new AsrStreamKey(languageCode);

        if (activeStreams.containsKey(streamKey)) {
            Set<String> activeStreamElements = activeStreams.get(streamKey);

            if (activeStreamElements != null) {
                for (String packageName : activeStreamElements) {
                    if (Objects.equals(packageName, "AugmentOS_INTERNAL")) {
                        continue;
                    }
                    Log.d(TAG, "Active stream element processed: " + packageName);
                    edgeTpaSystem.sendTranscriptEventToTpa(event, packageName);
                }
            } else {
                Log.w(TAG, "Active stream elements are null, nothing to process.");
            }
        }

        if (isFinal) {
            transcriptsBuffer.add(text);
        }
    }

    @Subscribe
    public void onTranslate(TranslateOutputEvent event){
        String fromLanguageCode = event.fromLanguageCode;
        String toLanguageCode = event.toLanguageCode;
        AsrStreamKey streamKey = new AsrStreamKey(fromLanguageCode, toLanguageCode);

        if (activeStreams.containsKey(streamKey)) {
            Set<String> activeStreamElements = activeStreams.get(streamKey);

            if (activeStreamElements != null) {
                for (String packageName : activeStreamElements) {
                    if (Objects.equals(packageName, "AugmentOS_INTERNAL")) {
                        continue;
                    }
                    Log.d(TAG, "Active stream element processed: " + packageName);
                    edgeTpaSystem.sendTranslateEventToTpa(event, packageName);
                }
            } else {
                Log.w(TAG, "Active stream elements are null, nothing to process.");
            }
        }
    }

    @Subscribe
    public synchronized void onSubscribeStartAsrStreamRequestEvent(StartAsrStreamRequestEvent event) {
        AsrStreamKey key;
        String transcribeLanguage = event.transcribeLanguage;
        if (event.asrStreamType == AsrStreamType.TRANSLATION) {
            String translateLanguage = event.translateLanguage;
            key = new AsrStreamKey(transcribeLanguage, translateLanguage);
        } else {
            key = new AsrStreamKey(transcribeLanguage);
        }
        addAsrStream(event.packageName, key);
    }

    @Subscribe
    public synchronized void onSubscribeStopAsrStreamRequestEvent(StopAsrStreamRequestEvent event) {
        AsrStreamKey key;
        String transcribeLanguage = event.transcribeLanguage;
        if (event.asrStreamType == AsrStreamType.TRANSLATION) {
            String translateLanguage = event.translateLanguage;
            key = new AsrStreamKey(transcribeLanguage, translateLanguage);
        } else {
            key = new AsrStreamKey(transcribeLanguage);
        }
        removeAsrStream(event.packageName, key);
    }

    private void addAsrStream(String packageName, AsrStreamKey key) {
        Set<String> subscribers = activeStreams.get(key);
        if (subscribers == null) {
            subscribers = new HashSet<>();
            activeStreams.put(key, subscribers);

            // Start the underlying ASR engine
            updateAsrLanguages();
        }

        subscribers.add(packageName);
        Log.d(TAG, "addAsrStream: " + packageName + " subscribed to " + key);
    }

    public void updateAsrLanguages() {
        //send the minimal list of languages to the speech rec framework
        EventBus.getDefault().post(new NewAsrLanguagesEvent(getActiveFilteredStreamKeys()));
    }

    private void removeAsrStream(String packageName, AsrStreamKey key) {
        Set<String> subscribers = activeStreams.get(key);
        if (subscribers == null) {
            Log.d(TAG, "removeAsrStream: Key " + key + " not active. Nothing to stop.");
            return;
        }

        subscribers.remove(packageName);
        Log.d(TAG, "removeAsrStream: " + packageName + " unsubscribed from " + key);

        if (subscribers.isEmpty()) {
            // Stop the underlying ASR
            activeStreams.remove(key);
            updateAsrLanguages();
        }
    }

    public synchronized List<AsrStreamKey> getActiveFilteredStreamKeys() {
        // 1) Find all languages that have at least one TRANSLATION active
        Set<String> translationLanguages = new HashSet<>();
        for (AsrStreamKey key : activeStreams.keySet()) {
            if (key.streamType == AsrStreamType.TRANSLATION) {
                translationLanguages.add(key.transcribeLanguage);
            }
        }

        // 2) Build the filtered list
        List<AsrStreamKey> filteredList = new ArrayList<>();
        for (AsrStreamKey key : activeStreams.keySet()) {
            if (key.streamType == AsrStreamType.TRANSLATION) {
                filteredList.add(key);
            } else if (key.streamType == AsrStreamType.TRANSCRIPTION) {
                if (!translationLanguages.contains(key.transcribeLanguage)) {
                    filteredList.add(key);
                }
            }
        }
        return filteredList;
    }

    @Subscribe
    public void onKillTpaEvent(KillTpaEvent event) {
        String tpaPackageName = event.tpa.packageName;
        Log.d(TAG, "TPA KILLING SELF: " + tpaPackageName);
        unsubscribeTpaFromAllStreams(tpaPackageName);
    }

    private void unsubscribeTpaFromAllStreams(String packageName) {
        for (Map.Entry<AsrStreamKey, Set<String>> entry : activeStreams.entrySet()) {
            entry.getValue().remove(packageName);
        }

        List<AsrStreamKey> keysToRemove = new ArrayList<>();
        for (Map.Entry<AsrStreamKey, Set<String>> entry : activeStreams.entrySet()) {
            AsrStreamKey key = entry.getKey();
            Set<String> subscribers = entry.getValue();

            if (subscribers.isEmpty()) {
                if (key.streamType == AsrStreamType.TRANSCRIPTION
                        && "en-US".equals(key.transcribeLanguage)) {
                    subscribers.add("AugmentOS_INTERNAL");
                } else {
                    keysToRemove.add(key);
                }
            }
        }

        for (AsrStreamKey removableKey : keysToRemove) {
            activeStreams.remove(removableKey);
        }
        updateAsrLanguages();
    }

}
