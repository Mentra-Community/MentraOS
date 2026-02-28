package com.mentra.asg_client.di;

import android.content.Context;

import com.mentra.asg_client.io.file.core.FileManagerFactory;

public class AppModule {

    public static void initialize(Context context) {
        FileManagerFactory.initialize(context);
    }
}
