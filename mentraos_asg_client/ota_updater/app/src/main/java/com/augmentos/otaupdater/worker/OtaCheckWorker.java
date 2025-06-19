package com.augmentos.otaupdater.worker;

/**
 * Created by markiyurtdas on 21.05.2025.
 */

import android.content.Context;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import com.augmentos.otaupdater.helper.Constants;
import com.augmentos.otaupdater.helper.OtaHelper;

public class OtaCheckWorker extends Worker {
        private static final String TAG = OtaCheckWorker.TAG;
        public OtaCheckWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Log.d(TAG, "Performing long running task in scheduled job");
        OtaHelper helper = new OtaHelper(getApplicationContext());
        helper.startVersionCheck(getApplicationContext());
        return Result.success();
    }
}