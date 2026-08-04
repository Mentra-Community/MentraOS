package com.mentra.asg_client.di.hilt;

import android.content.Context;
import com.mentra.asg_client.service.system.core.SystemControllerFactory;
import com.mentra.asg_client.service.system.interfaces.ISystemController;
import dagger.Module;
import dagger.Provides;
import dagger.hilt.InstallIn;
import dagger.hilt.android.qualifiers.ApplicationContext;
import dagger.hilt.components.SingletonComponent;
import javax.inject.Singleton;

@Module
@InstallIn(SingletonComponent.class)
public class SystemModule {

    @Provides
    @Singleton
    static ISystemController provideSystemController(@ApplicationContext Context context) {
        return SystemControllerFactory.get(context);
    }
}
