package com.mentra.asg_client.di.hilt;

import android.content.Context;
import com.mentra.asg_client.io.bes.BesOtaRegistry;
import com.mentra.asg_client.io.ota.helpers.OtaHelper;
import com.mentra.asg_client.io.ota.interfaces.IBesOtaRegistry;
import dagger.Module;
import dagger.Provides;
import dagger.hilt.InstallIn;
import dagger.hilt.android.qualifiers.ApplicationContext;
import dagger.hilt.components.SingletonComponent;
import javax.inject.Singleton;

@Module
@InstallIn(SingletonComponent.class)
public class OtaModule {

    /** Binds the core registry interface to the vendor singleton implementation. */
    @Provides
    @Singleton
    static IBesOtaRegistry provideBesOtaRegistry(BesOtaRegistry impl) {
        return impl;
    }

    @Provides
    @Singleton
    static OtaHelper provideOtaHelper(
            @ApplicationContext Context context, IBesOtaRegistry besOtaRegistry) {
        return new OtaHelper(context, besOtaRegistry);
    }
}
