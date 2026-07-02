package com.mentra.asg_client.di.hilt;

import com.mentra.asg_client.io.file.core.FileManager;
import com.mentra.asg_client.io.ota.helpers.OtaHelper;
import com.mentra.asg_client.io.ota.interfaces.IBesOtaRegistry;
import dagger.hilt.EntryPoint;
import dagger.hilt.InstallIn;
import dagger.hilt.components.SingletonComponent;

@EntryPoint
@InstallIn(SingletonComponent.class)
public interface AsgClientEntryPoint {
    FileManager fileManager();

    OtaHelper otaHelper();

    IBesOtaRegistry besOtaRegistry();
}
