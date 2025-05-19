package com.augmentos.augmentos_core.ui;

import android.app.AlertDialog;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Bundle;
import android.provider.Settings;
import android.text.TextUtils;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.Toast;

import androidx.fragment.app.Fragment;
import androidx.navigation.NavController;
import androidx.navigation.Navigation;
import androidx.recyclerview.widget.LinearLayoutManager;
import androidx.recyclerview.widget.RecyclerView;

import com.augmentos.augmentos_core.MainActivity;
import com.augmentos.augmentos_core.R;
import com.augmentos.augmentos_core.ResponseTextUiAdapter;
import com.augmentos.augmentos_core.TranscriptTextUiAdapter;
import com.augmentos.augmentos_core.events.UserIdChangedEvent;

import org.greenrobot.eventbus.EventBus;

import java.util.ArrayList;

public class AugmentosCoreUi extends Fragment {
  public String TAG = "WearableAi_AugmentOSUi";

  private static final String TARGET_PACKAGE = "com.augmentos.augmentos";

     //UI
  private ResponseTextUiAdapter responseTextUiAdapter;
  private RecyclerView responseRecyclerView;
  private TranscriptTextUiAdapter transcriptTextUiAdapter;
  private RecyclerView transcriptRecyclerView;
  public static final String UI_UPDATE_FULL = "UI_UPDATE_FULL";
  public static final String UI_UPDATE_SINGLE = "UI_UPDATE_SINGLE";
  public static final String UI_UPDATE_FINAL_TRANSCRIPT = "UI_UPDATE_FINAL_TRANSCRIPT";
  public static final String AUGMENTOS_CORE_MESSAGE_STRING = "AUGMENTOS_CORE_MESSAGE_STRING";
  public static final String TRANSCRIPTS_MESSAGE_STRING = "TRANSCRIPTS_MESSAGE_STRING";
  public static final String FINAL_TRANSCRIPT = "FINAL_TRANSCRIPT";
  private static final String fragmentLabel = "AugmentOS Core";

    private NavController navController;


    public AugmentosCoreUi() {
        // Required empty public constructor
    }

  private final BroadcastReceiver mMainServiceReceiver = new BroadcastReceiver() {
    @Override
    public void onReceive(Context context, Intent intent) {
      final String action = intent.getAction();
//      Log.d(TAG, "AugmentOSUi got something");
      if (UI_UPDATE_SINGLE.equals(action)) {
        String message = intent.getStringExtra(AUGMENTOS_CORE_MESSAGE_STRING);
        if (!message.equals("") && !message.equals(null)) {
//          Log.d(TAG, "Got message: " + message);
          addResponseTextBox(message);
        }
      } else if (UI_UPDATE_FULL.equals(action)){
        responseTextUiAdapter.clearTexts();
        transcriptTextUiAdapter.clearTexts();
        ArrayList<String> responsesBuffer = intent.getStringArrayListExtra(AUGMENTOS_CORE_MESSAGE_STRING);
        ArrayList<String> transcrriptsBuffer = intent.getStringArrayListExtra(TRANSCRIPTS_MESSAGE_STRING);
        for (String message : responsesBuffer) {
          addResponseTextBox(message, false);
        }
        responseRecyclerView.scrollToPosition(responseTextUiAdapter.getItemCount() - 1);
        for (String transcript : transcrriptsBuffer) {
          addTranscriptTextBox(transcript);
        }
        transcriptRecyclerView.scrollToPosition(transcriptTextUiAdapter.getItemCount() - 1);
      } else if (UI_UPDATE_FINAL_TRANSCRIPT.equals(action)){
        String transcript = intent.getStringExtra(FINAL_TRANSCRIPT);
        addTranscriptTextBox(transcript);
      }
    }
  };


  @Override
  public void onResume() {
    super.onResume();

    //unregister receiver
    getActivity().registerReceiver(mMainServiceReceiver, makeMainServiceReceiverIntentFilter());

    //trigger UI update
    if (((MainActivity)getActivity()).mService != null){
//       ((MainActivity)getActivity()).mService.sendUiUpdateFull();
    }
  }

  @Override
  public void onPause() {
    super.onPause();

    //unregister receiver
    getActivity().unregisterReceiver(mMainServiceReceiver);
  }

  //UI
  private static IntentFilter makeMainServiceReceiverIntentFilter() {
    final IntentFilter intentFilter = new IntentFilter();
    intentFilter.addAction(UI_UPDATE_FULL);
    intentFilter.addAction(UI_UPDATE_SINGLE);
    intentFilter.addAction(UI_UPDATE_FINAL_TRANSCRIPT);

    return intentFilter;
  }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // EventBus.getDefault().register(this);
    }

    @Override
    public void onDestroy() {
      super.onDestroy();
      // EventBus.getDefault().unregister(this);
    }

    @Override
    public View onCreateView(LayoutInflater inflater, ViewGroup container,
                             Bundle savedInstanceState) {

        // Inflate the layout for this fragment
        return inflater.inflate(R.layout.augmentos_core_fragment, container, false);
    }

    @Override
    public void onViewCreated(View view, Bundle savedInstanceState){
        //setup titlebar
        UiUtils.setupTitle(getActivity(), fragmentLabel);

        //get the nav controller
        navController = Navigation.findNavController(getActivity(), R.id.nav_host_fragment);

        //setup UI
        responseRecyclerView = view.findViewById(R.id.recyclerView);
        responseRecyclerView.setLayoutManager(new LinearLayoutManager(this.getContext()));
        responseTextUiAdapter = new ResponseTextUiAdapter(new ArrayList<>());
        responseRecyclerView.setAdapter(responseTextUiAdapter);
        transcriptRecyclerView = view.findViewById(R.id.rawTranscriptsRecyclerView);
        transcriptRecyclerView.setLayoutManager(new LinearLayoutManager(this.getContext()));
        transcriptTextUiAdapter = new TranscriptTextUiAdapter(new ArrayList<>());
        transcriptRecyclerView.setAdapter(transcriptTextUiAdapter);

        final Button settingsButton = view.findViewById(R.id.settings_button);
        settingsButton.setOnClickListener(v -> openSettingsFragment());

        final Button connectButton = view.findViewById(R.id.connect_button);
        connectButton.setOnClickListener(v -> connectGlasses());

        //scroll to bottom of scrolling UIs
        responseRecyclerView.scrollToPosition(responseTextUiAdapter.getItemCount() - 1);
        transcriptRecyclerView.scrollToPosition(transcriptTextUiAdapter.getItemCount() - 1);

      //auto start if we have perms (if we are already running/connected, this is still safe to call)
      if (!((MainActivity) getActivity()).gettingPermissions){
        //connectGlasses();

        if (((MainActivity) getActivity()).isAppInstalled(TARGET_PACKAGE)) {
          //((MainActivity) getActivity()).launchTargetApp(TARGET_PACKAGE);
          //((MainActivity) getActivity()).finish();
        }
      }
    }

  private void pickContact() {
//        Intent pickContactIntent = new Intent(Intent.ACTION_PICK, ContactsContract.Contacts.CONTENT_URI);
//        startActivityForResult(pickContactIntent, PICK_CONTACT_REQUEST);
    }

  // Call this method to add a new text box to the list
  public void addResponseTextBox(String text) {
    addResponseTextBox(text, true);
  }

  public void addResponseTextBox(String text, boolean scroll) {
    responseTextUiAdapter.addText(text);
    if (scroll){
      responseRecyclerView.smoothScrollToPosition(responseTextUiAdapter.getItemCount() - 1);
    }
//      responseRecyclerView.scrollToPosition(responseTextUiAdapter.getItemCount() - 1);
  }

  // Call this method to add a new text box to the list
  public void addTranscriptTextBox(String text) {
   addTranscriptTextBox(text, true);
  }

  public void addTranscriptTextBox(String text, boolean scroll) {
    transcriptTextUiAdapter.addText(text);
    if (scroll) {
      transcriptRecyclerView.smoothScrollToPosition(transcriptTextUiAdapter.getItemCount() - 1);
    }
  }

  // Change UserID button
  public void showTextInputDialog(Context context) {
    AlertDialog.Builder builder = new AlertDialog.Builder(context);
    builder.setTitle("Enter new UserID");

    // Set up the input
    final EditText input = new EditText(context);
    LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.MATCH_PARENT);
    input.setLayoutParams(lp);
    builder.setView(input);

    // Set up the buttons
    builder.setPositiveButton("OK", new DialogInterface.OnClickListener() {
      @Override
      public void onClick(DialogInterface dialog, int which) {
        String result = input.getText().toString();
        // Use the text result as needed
        handleTextInputResult(result);
      }
    });
    builder.setNegativeButton("Cancel", new DialogInterface.OnClickListener() {
      @Override
      public void onClick(DialogInterface dialog, int which) {
        dialog.cancel();
      }
    });

    builder.show();
  }

  private void handleTextInputResult(String result) {
    // Handle the text input result here
    Toast.makeText(this.getContext(), "Set UserID to: " + result, Toast.LENGTH_SHORT).show();
    EventBus.getDefault().post(new UserIdChangedEvent(result));
  }

  private void connectGlasses() {
      ((MainActivity)getActivity()).startAugmentosService();
  }

  private void openSettingsFragment() {
    navController.navigate(R.id.nav_settings);
  }

  public static boolean isNotificationServiceEnabled(Context context) {
    String pkgName = context.getPackageName();
    final String flat = Settings.Secure.getString(context.getContentResolver(), "enabled_notification_listeners");
    if (!TextUtils.isEmpty(flat)) {
      final String[] names = flat.split(":");
      for (String name : names) {
        final ComponentName cn = ComponentName.unflattenFromString(name);
        if (cn != null) {
          if (TextUtils.equals(pkgName, cn.getPackageName())) {
            return true;
          }
        }
      }
    }
    return false;
  }

}

