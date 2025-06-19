package com.augmentos.augmentos_core.ui;

import android.graphics.drawable.Drawable;
import android.os.Bundle;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.fragment.app.Fragment;
import androidx.navigation.NavController;
import androidx.navigation.Navigation;

import com.augmentos.augmentos_core.MainActivity;
import com.augmentos.augmentos_core.R;
import com.augmentos.augmentos_core.smarterglassesmanager.supportedglasses.SmartGlassesDevice;

public class GlassesConnectedFragment extends Fragment {
    private  final String TAG = "WearableAi_GlassesConnectedFragment";

    private final String fragmentLabel = "Connecting to Smart Glasses";

    private NavController navController;

    public GlassesConnectedFragment() {
    }

    @Override
    public View onCreateView(LayoutInflater inflater, ViewGroup container,
                             Bundle savedInstanceState) {
        // Inflate the layout for this fragment
        return inflater.inflate(R.layout.glasses_connected_fragment, container, false);
    }

    @Override
    public void onViewCreated(@NonNull View view, @Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        //setup the title
        UiUtils.setupTitle(getActivity(), fragmentLabel);

        navController = Navigation.findNavController(getActivity(), R.id.nav_host_fragment);

        //get the selected device
        SmartGlassesDevice device = ((MainActivity)getActivity()).selectedDevice;
        if (device == null){
            return;
        }

        //setup the image view
        ImageView connectedImageIv = (ImageView) view.findViewById(R.id.connected_glasses_image);
        String uri = "@drawable/" + device.getDeviceIconName();  // where myresource (without the extension) is the file
        int imageResource = view.getContext().getResources().getIdentifier(uri, null, view.getContext().getPackageName());
        Drawable res = view.getContext().getResources().getDrawable(imageResource);
        connectedImageIv.setImageDrawable(res);

        //setup the message
        TextView connectedMessageTv = (TextView) view.findViewById(R.id.glasses_connected_message_tv);
        connectedMessageTv.setText(device.getDeviceModelName() + " is now connected!");

        final Button okButton = view.findViewById(R.id.ok_glasses_connected_button);
        okButton.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                // Code here executes on main thread after user presses button
                navController.navigate(R.id.nav_settings);
            }
        });
    }
}
