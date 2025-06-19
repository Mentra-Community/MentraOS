package com.augmentos.augmentos_core.ui;

import android.app.Activity;

import com.augmentos.augmentos_core.MainActivity;
import com.augmentos.augmentos_core.R;

public class UiUtils {

    //set app bar title
    public static void setupTitle(Activity activity, String title) {
        //Toolbar toolbar = (Toolbar) activity.findViewById(R.id.main_toolbar);
        //((MainActivity) activity).setSupportActionBar(toolbar);
        ((MainActivity) activity).getSupportActionBar().setTitle(title);
    }
}
