package com.mentra.asg_client.di.hilt;

import android.content.Context;
import com.mentra.asg_client.io.file.core.FileManager;
import com.mentra.asg_client.io.file.core.FileManagerFactory;
import com.mentra.asg_client.io.file.platform.AndroidPlatformStrategy;
import com.mentra.asg_client.logging.Logger;
import dagger.Module;
import dagger.Provides;
import dagger.hilt.InstallIn;
import dagger.hilt.android.qualifiers.ApplicationContext;
import dagger.hilt.components.SingletonComponent;
import java.io.File;
import javax.inject.Singleton;

@Module
@InstallIn(SingletonComponent.class)
public class FileModule {

    @Provides
    @Singleton
    static FileManager provideFileManager(@ApplicationContext Context context) {
        AndroidPlatformStrategy strategy = new AndroidPlatformStrategy(context);
        Logger logger = strategy.createLogger();
        File baseDir = strategy.getBaseDirectory();
        if (baseDir == null) {
            baseDir = context.getFilesDir();
            if (baseDir == null) {
                throw new IllegalStateException("No usable file directory available");
            }
            logger.warn(
                    "FileModule",
                    "External files directory unavailable; falling back to internal files dir: "
                            + baseDir.getAbsolutePath());
        }
        return FileManagerFactory.createInstance(baseDir, logger);
    }
}
