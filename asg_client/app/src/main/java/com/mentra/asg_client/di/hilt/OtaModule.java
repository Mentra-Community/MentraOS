package com.mentra.asg_client.di.hilt;

import android.content.Context;
import com.mentra.asg_client.io.bes.BesOtaRegistry;
import com.mentra.asg_client.io.ota.helpers.OtaHelper;
import dagger.Module;
import dagger.Provides;
import dagger.hilt.InstallIn;
import dagger.hilt.android.qualifiers.ApplicationContext;
import dagger.hilt.components.SingletonComponent;
import javax.inject.Singleton;

@Module
@InstallIn(SingletonComponent.class)
public class OtaModule {

    @Provides
    @Singleton
    static OtaHelper provideOtaHelper(
            @ApplicationContext Context context, BesOtaRegistry besOtaRegistry) {
        return new OtaHelper(context, besOtaRegistry);
    }
}
