package com.mentra.asg_client.camera.lifecycle;

import android.os.Handler;
import androidx.annotation.NonNull;
import java.util.concurrent.Executor;

/** Runs tasks on a {@link Handler}'s looper (required for Camera2 session callbacks). */
public final class HandlerExecutor implements Executor {

    private final Handler handler;

    public HandlerExecutor(@NonNull Handler handler) {
        this.handler = handler;
    }

    @Override
    public void execute(@NonNull Runnable command) {
        if (handler.getLooper().getThread().isAlive()) {
            handler.post(command);
        }
    }
}
