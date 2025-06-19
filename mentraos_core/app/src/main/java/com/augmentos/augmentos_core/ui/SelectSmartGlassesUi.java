package com.augmentos.augmentos_core.ui;

import android.app.AlertDialog;
import android.content.DialogInterface;
import android.os.Bundle;
import android.util.Log;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.AdapterView;
import android.widget.Button;
import android.widget.ListView;

import androidx.fragment.app.Fragment;
import androidx.navigation.NavController;
import androidx.navigation.Navigation;

import com.augmentos.augmentos_core.MainActivity;
import com.augmentos.augmentos_core.R;
import com.augmentos.augmentos_core.smarterglassesmanager.supportedglasses.AudioWearable;
import com.augmentos.augmentos_core.smarterglassesmanager.supportedglasses.InmoAirOne;
import com.augmentos.augmentos_core.smarterglassesmanager.supportedglasses.MentraMach1;
import com.augmentos.augmentos_core.smarterglassesmanager.supportedglasses.SmartGlassesDevice;
import com.augmentos.augmentos_core.smarterglassesmanager.supportedglasses.TCLRayNeoXTwo;
import com.augmentos.augmentos_core.smarterglassesmanager.supportedglasses.VuzixShield;
import com.augmentos.augmentos_core.smarterglassesmanager.supportedglasses.VuzixUltralite;

import java.util.ArrayList;

public class SelectSmartGlassesUi extends Fragment {
    public String TAG = "WearableAi_SelectSmartGlassesUi";

    private final String fragmentLabel = "Select Glasses to Connect...";

    private NavController navController;

    //UI elements
    private ListView glassesList;

    public SmartGlassesDevice [] smartGlassesDevices;

    public SelectSmartGlassesUi() {
        // Required empty public constructor
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        smartGlassesDevices = new SmartGlassesDevice[]{new VuzixShield(), new InmoAirOne(), new TCLRayNeoXTwo(), new VuzixUltralite(), new MentraMach1(), new AudioWearable()};
    }

    @Override
    public View onCreateView(LayoutInflater inflater, ViewGroup container,
                             Bundle savedInstanceState) {

        // Inflate the layout for this fragment
        return inflater.inflate(R.layout.select_glasses_fragment, container, false);
    }

    @Override
    public void onViewCreated(View view, Bundle savedInstanceState){
        //setup titlebar
        UiUtils.setupTitle(getActivity(), fragmentLabel);

        //get the nav controller
        navController = Navigation.findNavController(getActivity(), R.id.nav_host_fragment);

        //setup list of smart glasses
        glassesList = view.findViewById(R.id.smart_glasses_list);

        // on the below line we are initializing the adapter for our list view.
        ArrayList<SmartGlassesDevice> glassesArrayList = new ArrayList<>();

        //ArrayAdapter<String> glassesListAdapter = new ArrayAdapter<>(view.getContext(), android.R.layout.simple_list_item_activated_1, glassesArrayList);
        SmartGlassesListAdapter glassesListAdapter = new SmartGlassesListAdapter(glassesArrayList, getContext());

        //listen for list presses
        glassesList.setOnItemClickListener(new AdapterView.OnItemClickListener()
        {
            @Override
            public void onItemClick(AdapterView<?> adapter, View v, int position,
                                    long arg3)
            {
                glassesListAdapter.setSelectedPosition(position);
            }
        });

        // on below line we are setting adapter for our list view.
        glassesList.setAdapter(glassesListAdapter);
        for (SmartGlassesDevice device : smartGlassesDevices){
            Log.d(TAG, device.getDeviceModelName());
            glassesListAdapter.add(device);
        }

        //setup buttons
        final Button cancelButton = view.findViewById(R.id.cancel_select_smart_glasses_button);
        cancelButton.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                // Code here executes on main thread after user presses button
                ((MainActivity)getActivity()).onBackPressed();
            }
        });

        final Button selectButton = view.findViewById(R.id.select_smart_glasses_button);
        selectButton.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                // Code here executes on main thread after user presses button
                SmartGlassesDevice selectedDevice = glassesListAdapter.getSelectedDevice();
                if (selectedDevice == null) {
                    Log.d(TAG, "Please choose a smart glasses device to continue.");
                    showNoGlassSelectedDialog();
                } else if (!selectedDevice.getAnySupport()){
                    Log.d(TAG, "Glasses not yet supported, we're working on it.");
                    showUnsupportedGlassSelected();
                } else {
                    Log.d(TAG, "Connecting to " + selectedDevice.getDeviceModelName() + "...");
                    //((MainActivity)getActivity()).connectSmartGlasses(selectedDevice);

                    navController.navigate(R.id.nav_connecting_to_smart_glasses);
                    //((MainActivity)getActivity()).onBackPressed();
                }
            }
        });
    }

    public void showNoGlassSelectedDialog(){
        new AlertDialog.Builder(this.getContext()) .setIcon(android.R.drawable.ic_dialog_alert)
                .setTitle("No Smart Glasses Selected")
                .setMessage("Please select a smart glasses model from the list to proceed, or press 'Cancel'.")
                .setPositiveButton("Ok", new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                    }
                }).show();
    }

    public void showUnsupportedGlassSelected(){
        new AlertDialog.Builder(this.getContext()) .setIcon(android.R.drawable.ic_dialog_info)
                .setTitle("Unsupported Smart Glasses Selected")
                .setMessage("We don't yet support those smart glasses, but we're working to add support for them. Please choose another pair of smart glasses from the list.")
                .setPositiveButton("Ok", new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                    }
                }).show();
    }
}

