package com.mentra.asg_client.di.hilt;

import android.content.Context;
import com.mentra.asg_client.io.hardware.core.HardwareManagerFactory;
import com.mentra.asg_client.io.hardware.interfaces.IHardwareManager;
import dagger.Module;
import dagger.Provides;
import dagger.hilt.InstallIn;
import dagger.hilt.android.qualifiers.ApplicationContext;
import dagger.hilt.components.SingletonComponent;
import javax.inject.Singleton;

@Module
@InstallIn(SingletonComponent.class)
public class HardwareModule {

    @Provides
    @Singleton
    static IHardwareManager provideHardwareManager(@ApplicationContext Context context) {
        return HardwareManagerFactory.getInstance(context);
    }
}
