package com.augmentos.augmentos_core.smarterglassesmanager.texttospeech;

import android.content.Context;
import android.media.AudioManager;
import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.util.Log;

import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.PauseAsrEvent;
import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.ScoStartEvent;
import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.TextToSpeechEvent;

import org.greenrobot.eventbus.EventBus;
import org.greenrobot.eventbus.Subscribe;

import java.util.HashMap;
import java.util.Locale;
import java.util.UUID;

public class TextToSpeechSystem {
    private  final String TAG = "WearableAi_TextToSpeechSystem";

    private Context mContext;
    public boolean isLoaded = false;
    private TextToSpeech ttsModel;
    private boolean sco;

    public TextToSpeechSystem(Context context){
        this.mContext = context;
        this.sco = false;
        EventBus.getDefault().register(this);
    }

    public void useSco(boolean useSco){
        this.sco = useSco;
    }

//    public void setup(Locale language){
    public void setup(){
        Locale language = Locale.ENGLISH;
        ttsModel = new TextToSpeech(mContext, status -> {
            if (status == TextToSpeech.SUCCESS) {
                ttsModel.setLanguage(language);
//                ttsModel.setSpeechRate(1.6f);
//                ttsModel.setPitch(0.8f);
//                ttsModel.setAudioAttributes(new AudioAttributes.Builder()
//                        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
//                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
//                        .build());
//                Log.d("TextToSpeech","TTS Model initialized");
                this.isLoaded = true;
//                Log.d(TAG, ttsModel.getVoices().toString());
                Log.d(TAG, ttsModel.getDefaultEngine());
            } else {
//                Log.d(TAG, "TTS failed with code: " + status);
            }
        });
    }

    //default speak (english)
    public void speak(String text){
        speak(text, Locale.ENGLISH) ;
    }
    
    public void speak(String text, String languageString) {
        Locale language = Locale.ENGLISH; // Default to English
        switch (languageString.toLowerCase()) {
            case "english":
                language = Locale.ENGLISH;
                break;
            case "chinese":
                language = Locale.CHINESE; // or Locale.SIMPLIFIED_CHINESE for more specificity
                break;
            case "chinese (pinyin)":
                language = Locale.CHINESE; // or Locale.SIMPLIFIED_CHINESE for more specificity
                break;
            case "italian":
                language = Locale.ITALIAN;
                break;
            case "japanese":
                language = Locale.JAPANESE;
                break;
            case "spanish":
                language = new Locale("es", "ES");
                break;
            case "russian":
                language = new Locale("ru", "RU");
                break;
            case "dutch":
                language = new Locale("nl", "NL");
                break;
            case "hebrew":
                language = new Locale("iw", "IL");
                break;
            default:
                // Log or alert the user that the language is not supported for direct Locale constants
                Log.d(TAG, "Language not supported by TTS: " + languageString);
                break;
        }
        speak(text, language);
    }

    public void speak(String text, Locale locale){
        Log.d(TAG, "TTS speaking text: " + text);
        Log.d(TAG, "TTS speaking this language: " + locale.toString());
        if (this.isLoaded){
            //setup memory of this tts
            HashMap<String, String> params = new HashMap<>();
            String utteranceId = UUID.randomUUID().toString();
            params.put(TextToSpeech.Engine.KEY_PARAM_UTTERANCE_ID, utteranceId);

            // TTS engine is initialized successfully
            int result = ttsModel.setLanguage(locale);
            if (result == TextToSpeech.LANG_MISSING_DATA || result == TextToSpeech.LANG_NOT_SUPPORTED) {
                Log.e(TAG, "Language is not supported or missing data: " + locale);
                return;
            }

            ttsModel.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override
                public void onStart(String utteranceId) {
                    // TTS starts speaking
                    EventBus.getDefault().post(new PauseAsrEvent(true));
                }

                @Override
                public void onDone(String utteranceId) {
                    EventBus.getDefault().post(new PauseAsrEvent(false));
                }

                @Override
                public void onError(String utteranceId) {
                    // Handle TTS error
                }
            });

            if (sco) {
                Bundle ttsParams = new Bundle();
                ttsParams.putInt(TextToSpeech.Engine.KEY_PARAM_STREAM, AudioManager.STREAM_VOICE_CALL);
                ttsParams.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, 1.0f);
                ttsModel.speak(text, TextToSpeech.QUEUE_FLUSH, ttsParams, utteranceId);
            } else {
                ttsModel.speak(text, TextToSpeech.QUEUE_FLUSH, null, utteranceId);
            }
        } else {
            Log.d(TAG, "TTS failed because not loaded.");
        }

    }

    public void destroy(){
        EventBus.getDefault().unregister(this);
        if (ttsModel != null) {
            ttsModel.shutdown();
        }

//        Log.d("TextToSpeech","TTS destroyed");
    }


    @Subscribe
    public void handleTtsEvent(TextToSpeechEvent event) {
        String languageString = event.language;
        Locale language = Locale.ENGLISH; // Default to English
        switch (languageString.toLowerCase()) {
            case "english":
                language = Locale.ENGLISH;
                break;
            case "chinese":
                language = Locale.CHINESE; // or Locale.SIMPLIFIED_CHINESE for more specificity
                break;
            case "chinese (pinyin)":
                language = Locale.CHINESE; // or Locale.SIMPLIFIED_CHINESE for more specificity
                break;
            case "italian":
                language = Locale.ITALIAN;
                break;
            case "japanese":
                language = Locale.JAPANESE;
                break;
            case "spanish":
                language = new Locale("es", "ES");
                break;
            case "russian":
                language = new Locale("ru", "RU");
                break;
            case "dutch":
                language = new Locale("nl", "NL");
                break;
            case "hebrew":
                language = new Locale("iw", "IL");
                break;
            default:
                // Log or alert the user that the language is not supported for direct Locale constants
                Log.d(TAG, "Language not supported by TTS: " + languageString);
                break;
        }
        speak(event.text, language);
    }

    @Subscribe
    public void handleScoEvent(ScoStartEvent event) {
        useSco(event.scoStart);
    }
}
