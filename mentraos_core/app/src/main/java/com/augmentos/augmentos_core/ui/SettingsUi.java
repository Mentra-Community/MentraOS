package com.augmentos.augmentos_core.ui;

import android.content.Context;
import android.os.Bundle;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.CompoundButton;
import android.widget.Switch;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import androidx.fragment.app.Fragment;
import androidx.navigation.NavController;
import androidx.navigation.Navigation;

import com.augmentos.augmentos_core.MainActivity;
import com.augmentos.augmentos_core.R;
import com.augmentos.augmentos_core.smarterglassesmanager.SmartGlassesManager;
import com.augmentos.augmentos_core.smarterglassesmanager.supportedglasses.AudioWearable;

public class SettingsUi extends Fragment {
    private  final String TAG = "WearableAi_SettingsUIFragment";

    private final String fragmentLabel = "Settings";

    private NavController navController;

    //test card raw data
    public String testCardImg = "https://ichef.bbci.co.uk/news/976/cpsprodpb/7727/production/_103330503_musk3.jpg";
    public String testCardTitle = "Test Card";
    public String testCardContent = "This is an example of a reference card. This appears on your glasses after pressing the 'Send Test Card' button.";

    public SettingsUi() {
    }

    @Override
    public View onCreateView(LayoutInflater inflater, ViewGroup container,
                             Bundle savedInstanceState) {
        // Inflate the layout for this fragment
        return inflater.inflate(R.layout.settings_fragment, container, false);
    }

    @Override
    public void onViewCreated(@NonNull View view, @Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        UiUtils.setupTitle(getActivity(), fragmentLabel);

        navController = Navigation.findNavController(getActivity(), R.id.nav_host_fragment);
        Context mContext = this.getContext();

        final Button killServiceButton = view.findViewById(R.id.kill_wearableai_service);
        killServiceButton.setOnClickListener(new View.OnClickListener() {
                public void onClick(View v) {
                // Code here executes on main thread after user presses button
                ((MainActivity)getActivity()).mService.disconnectWearable("");
            }
        });

        final Button connectSmartGlassesButton = view.findViewById(R.id.connect_smart_glasses);
            connectSmartGlassesButton.setOnClickListener(new View.OnClickListener() {
                public void onClick(View v) {
                    ((MainActivity)getActivity()).mService.disconnectWearable("");
                    ((MainActivity)getActivity()).mService.connectToWearable("","");
                }
        });

        final Switch glassesAudioToggle = view.findViewById(R.id.glasses_audio_toggle);

        glassesAudioToggle.setChecked(SmartGlassesManager.getPreferredWearable(getContext()).equals(new AudioWearable().deviceModelName)); // off by default
        glassesAudioToggle.setOnCheckedChangeListener(new CompoundButton.OnCheckedChangeListener() {
            @Override
            public void onCheckedChanged(CompoundButton compoundButton, boolean isChecked) {
                if (isChecked){
                    SmartGlassesManager.savePreferredWearable(getContext(), new AudioWearable().deviceModelName);
                    ((MainActivity)getActivity()).mService.disconnectWearable("");
                    ((MainActivity)getActivity()).mService.connectToWearable("","");
                }
                else {
                    SmartGlassesManager.savePreferredWearable(getContext(), "");
                    ((MainActivity)getActivity()).mService.disconnectWearable("");
                    ((MainActivity)getActivity()).mService.connectToWearable("","");
                }
            }
        });

        final Button logOutButton = view.findViewById(com.augmentos.augmentos_core.R.id.log_out_button);
        logOutButton.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                ((MainActivity)getActivity()).signOut();
            }
        });

        //ll vocabulary upgrade checkbox
//        CheckBox vocabularyUpgradeCheckbox = view.findViewById(R.id.VocabularyUpgrade);
//        boolean isVocabularyUpgradeEnabled;
//        isVocabularyUpgradeEnabled = AugmentosService.isVocabularyUpgradeEnabled(mContext);
//        Log.d(TAG, "Initial Vocabulary Upgrade state: " + isVocabularyUpgradeEnabled);
//        vocabularyUpgradeCheckbox.setChecked(isVocabularyUpgradeEnabled);
//
//        vocabularyUpgradeCheckbox.setOnCheckedChangeListener(new CompoundButton.OnCheckedChangeListener() {
//            @Override
//            public void onCheckedChanged(CompoundButton buttonView, boolean isChecked) {
//                Log.d(TAG, "Vocabulary Upgrade checkbox changed: " + isChecked);
//                ((MainActivity)getActivity()).mService.setVocabularyUpgradeEnabled(mContext, isChecked);
//                ((MainActivity)getActivity()).mService.updateVocabularyUpgradeOnBackend(mContext);
//                ((MainActivity)getActivity()).mService.disconnectWearable("");
//                ((MainActivity)getActivity()).mService.connectToWearable("");
//            }
//        });
//
//        //setup transcript language spinner
//        Spinner transcribeLanguageSpinner = view.findViewById(R.id.transcribeLanguageSpinner);
//        ArrayAdapter<CharSequence> transcribeAdapter = ArrayAdapter.createFromResource(mContext,
//                R.array.language_options, android.R.layout.simple_spinner_item);
//        transcribeAdapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
//        transcribeLanguageSpinner.setAdapter(transcribeAdapter);
//
//        // Retrieve the saved transcribe language
//        String savedTranscribeLanguage = SmartGlassesAndroidService.getChosenTranscribeLanguage(mContext);
//
//        // Find the position of the saved language in the adapter
//        int languageSpinnerPosition = transcribeAdapter.getPosition(savedTranscribeLanguage);
//
//        // Set the Spinner to show the saved language
//        transcribeLanguageSpinner.setSelection(languageSpinnerPosition);
//
//        transcribeLanguageSpinner.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
//            boolean initTranscribeLanguageSetup = true;
//
//            @Override
//            public void onItemSelected(AdapterView<?> parent, View view, int position, long id) {
//                if (initTranscribeLanguageSetup){
//                    initTranscribeLanguageSetup = false;
//                    return;
//                }
//                String selectedLanguage = parent.getItemAtPosition(position).toString();
//                // Save the selected language as the new transcribe language default
//                Log.d(TAG, "TRANSCRIBE LANGUAGE SPINNER CHANGED");
//                SmartGlassesAndroidService.saveChosenTranscribeLanguage(mContext, selectedLanguage);
//                ((MainActivity)getActivity()).mService.disconnectWearable("");
//                ((MainActivity)getActivity()).mService.connectToWearable("");
//            }
//
//            @Override
//            public void onNothingSelected(AdapterView<?> parent) {
//                // Another interface callback
//            }
//        });
//
//        //setup target targetLanguage spinner
//        Spinner targetLanguageSpinner = view.findViewById(R.id.targetLanguageSpinner);
//        ArrayAdapter<CharSequence> tlAdapter = ArrayAdapter.createFromResource(mContext,
//                R.array.language_options, android.R.layout.simple_spinner_item);
//        tlAdapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
//        targetLanguageSpinner.setAdapter(tlAdapter);
//
//        // Retrieve the saved target targetLanguage
//        String savedTargetLanguage = AugmentosService.getChosenTargetLanguage(mContext);
//
//        Log.d(TAG, "TARGET LANGUAGE IS: " + savedTargetLanguage);
//
//        // Find the position of the saved targetLanguage in the adapter
//        int targetLanguageSpinnerPosition = tlAdapter.getPosition(savedTargetLanguage);
//
//        // Set the Spinner to show the saved targetLanguage
//        targetLanguageSpinner.setSelection(targetLanguageSpinnerPosition);
//
//        targetLanguageSpinner.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
//            boolean initTargetLanguageSetup = true;
//
//            @Override
//            public void onItemSelected(AdapterView<?> parent, View view, int position, long id) {
//                if (initTargetLanguageSetup){
//                    initTargetLanguageSetup = false;
//                    return;
//                }
//                String selectedLanguage = parent.getItemAtPosition(position).toString();
//                // Save the selected targetLanguage as the new default
//                Log.d(TAG, "TARGET LANGUAGE SPINNER CHANGED");
//                AugmentosService.saveChosenTargetLanguage(mContext, selectedLanguage);
//                if (((MainActivity)getActivity()).isAugmentosServiceRunning()) {
//                    ((MainActivity) getActivity()).mService.updateTargetLanguageOnBackend(mContext);
//                    ((MainActivity)getActivity()).mService.disconnectWearable("");
//                    ((MainActivity)getActivity()).mService.connectToWearable("");
//                }
//            }
//
//            @Override
//            public void onNothingSelected(AdapterView<?> parent) {
//                // Another interface callback
//            }
//        });
//
//        //setup source sourceLanguage spinner
//        Spinner sourceLanguageSpinner = view.findViewById(R.id.sourceLanguageSpinner);
//        ArrayAdapter<CharSequence> slAdapter = ArrayAdapter.createFromResource(mContext,
//                R.array.language_options, android.R.layout.simple_spinner_item);
//        slAdapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
//        sourceLanguageSpinner.setAdapter(slAdapter);
//
//        // Retrieve the saved source sourceLanguage
//        String savedSourceLanguage = AugmentosService.getChosenSourceLanguage(mContext);
//
//        // Find the position of the saved sourceLanguage in the adapter
//        int sourceLanguageSpinnerPosition = slAdapter.getPosition(savedSourceLanguage);
//
//        // Set the Spinner to show the saved sourceLanguage
//        sourceLanguageSpinner.setSelection(sourceLanguageSpinnerPosition);
//
//        sourceLanguageSpinner.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
//            boolean initSourceLanguageSetup = true;
//
//            @Override
//            public void onItemSelected(AdapterView<?> parent, View view, int position, long id) {
//                if (initSourceLanguageSetup){
//                    initSourceLanguageSetup = false;
//                    return;
//                }
//                String selectedLanguage = parent.getItemAtPosition(position).toString();
//                // Save the selected targetLanguage as the new default
//                Log.d(TAG, "SOURCE LANGUAGE SPINNER CHANGED");
//                AugmentosService.saveChosenSourceLanguage(mContext, selectedLanguage);
//                if (((MainActivity)getActivity()).isAugmentosServiceRunning()) {
//                    ((MainActivity)getActivity()).mService.updateSourceLanguageOnBackend(mContext);
//                    ((MainActivity)getActivity()).mService.disconnectWearable("");
//                    ((MainActivity)getActivity()).mService.connectToWearable("");
//                }
//            }
//
//            @Override
//            public void onNothingSelected(AdapterView<?> parent) {
//                // Another interface callback
//            }
//        });
//
//        // setup live captions toggle
//        final RadioGroup liveCaptionsTranslationRadioGroup = view.findViewById(R.id.liveCaptionsTranslationRadioGroup);
//        final RadioButton languageLearningRadioButton = view.findViewById(R.id.languageLearning);
//        final RadioButton languageLearningWithLiveCaptionsRadioButton = view.findViewById(R.id.languageLearningWithLiveCaptions);
//        final RadioButton liveTranslationWithLiveCaptionsRadioButton = view.findViewById(R.id.liveTranslationWithLiveCaptions);
//
//        final int liveCaptionsTranslationSelected = SmartGlassesAndroidService.getSelectedLiveCaptionsTranslation(mContext) % 3;
//        if (liveCaptionsTranslationSelected == 0) {
//            languageLearningRadioButton.setChecked(true);
//        } else if (liveCaptionsTranslationSelected == 1) {
//            languageLearningWithLiveCaptionsRadioButton.setChecked(true);
//        } else if (liveCaptionsTranslationSelected == 2) {
//            liveTranslationWithLiveCaptionsRadioButton.setChecked(true);
//        }
//
//        liveCaptionsTranslationRadioGroup.setOnCheckedChangeListener(new RadioGroup.OnCheckedChangeListener() {
//            @Override
//            public void onCheckedChanged(RadioGroup group, int checkedId) {
//                int buttonId;
//                switch (checkedId) {
//                    case R.id.languageLearning:
//                        buttonId = 0;
//                        break;
//                    case R.id.languageLearningWithLiveCaptions:
//                    default:
//                        buttonId = 1;
//                        break;
//                    case R.id.liveTranslationWithLiveCaptions:
//                        buttonId = 2;
//                        break;
//                }
//                SmartGlassesAndroidService.saveSelectedLiveCaptionsTranslationChecked(mContext, buttonId); // normalize the id
//                ((MainActivity)getActivity()).mService.disconnectWearable("");
//                ((MainActivity)getActivity()).mService.connectToWearable("");
//            }
//        });

//        final CheckBox shouldDisplayNotificationsCheckbox = view.findViewById(R.id.should_display_notifications_toggle);
//        final boolean isShouldDisplayNotificationsChecked = PreferenceManager.getDefaultSharedPreferences(getContext()).getBoolean("should_display_notifications", false);
//        shouldDisplayNotificationsCheckbox.setChecked(isShouldDisplayNotificationsChecked);
//        shouldDisplayNotificationsCheckbox.setOnCheckedChangeListener(new CompoundButton.OnCheckedChangeListener() {
//            @Override
//            public void onCheckedChanged(CompoundButton compoundButton, boolean isChecked) {
//                PreferenceManager.getDefaultSharedPreferences(getContext())
//                        .edit()
//                        .putBoolean("should_display_notifications", isChecked)
//                        .apply();
//            }
//        });

    }


    @Override
    public void onResume() {
        super.onResume();
        UiUtils.setupTitle(getActivity(), fragmentLabel);
        // Show the back button when the fragment is visible
        ((AppCompatActivity) getActivity()).getSupportActionBar().setDisplayHomeAsUpEnabled(true);
    }

    @Override
    public void onPause() {
        super.onPause();
        // Hide the back button when the fragment is no longer visible
        ((AppCompatActivity) getActivity()).getSupportActionBar().setDisplayHomeAsUpEnabled(false);
    }
}
