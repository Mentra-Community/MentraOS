package com.augmentos.augmentos_core.ui;

import android.os.Bundle;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.fragment.app.Fragment;
import androidx.navigation.NavController;
import androidx.navigation.Navigation;

import com.augmentos.augmentos_core.MainActivity;
import com.augmentos.augmentos_core.R;

public class ConnectingToSmartGlassesUi extends Fragment {
    private  final String TAG = "WearableAi_ConnectingToSmartGlassesUIFragment";

    private final String fragmentLabel = "Connecting to Smart Glasses";

    private NavController navController;

    public ConnectingToSmartGlassesUi() {
    }

    @Override
    public View onCreateView(LayoutInflater inflater, ViewGroup container,
                             Bundle savedInstanceState) {
        // Inflate the layout for this fragment
        return inflater.inflate(R.layout.connecting_to_glasses_fragment, container, false);
    }

    @Override
    public void onViewCreated(@NonNull View view, @Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        //setup the title
        UiUtils.setupTitle(getActivity(), fragmentLabel);

        navController = Navigation.findNavController(getActivity(), R.id.nav_host_fragment);

        final Button cancelConnectButton = view.findViewById(R.id.ok_glasses_connected_button);
        cancelConnectButton.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                // Code here executes on main thread after user presses button
                ((MainActivity)getActivity()).stopAugmentosService();
                navController.navigate(R.id.nav_settings);
            }
        });
    }
}