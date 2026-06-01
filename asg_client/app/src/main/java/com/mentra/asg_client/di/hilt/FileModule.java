package com.mentra.asg_client.di.hilt;

import android.content.Context;

import com.mentra.asg_client.io.file.core.FileManager;
import com.mentra.asg_client.io.file.core.FileManagerFactory;
import com.mentra.asg_client.io.file.platform.AndroidPlatformStrategy;

import java.io.File;

import javax.inject.Singleton;

import dagger.Module;
import dagger.Provides;
import dagger.hilt.InstallIn;
import dagger.hilt.android.qualifiers.ApplicationContext;
import dagger.hilt.components.SingletonComponent;

@Module
@InstallIn(SingletonComponent.class)
public class FileModule {

    @Provides
    @Singleton
    static FileManager provideFileManager(@ApplicationContext Context context) {
        AndroidPlatformStrategy strategy = new AndroidPlatformStrategy(context);
        File baseDir = strategy.getBaseDirectory();
        return FileManagerFactory.createInstance(baseDir, strategy.createLogger());
    }
}
