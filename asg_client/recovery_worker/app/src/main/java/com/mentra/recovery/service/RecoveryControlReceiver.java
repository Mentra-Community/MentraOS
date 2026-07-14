package com.mentra.recovery.service;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import androidx.work.ExistingWorkPolicy;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;

import com.mentra.recovery.install.AsgInstallTransactionStore;
import com.mentra.recovery.util.RecoveryConstants;
import com.mentra.recovery.work.AsgInstallRetryWorker;
import java.util.concurrent.TimeUnit;

/** Starts {@link RecoveryService} when ASG requests recovery via a permission-guarded broadcast. */
public class RecoveryControlReceiver extends BroadcastReceiver {
  @Override
  public void onReceive(Context context, Intent intent) {
    if (intent == null) {
      return;
    }
    if (RecoveryConstants.ACTION_ASG_INSTALL_PENDING.equals(intent.getAction())) {
      long target = intent.getLongExtra(RecoveryConstants.EXTRA_TARGET_ASG_VERSION, -1L);
      String sha256 = intent.getStringExtra(RecoveryConstants.EXTRA_APK_SHA256);
      boolean downgrade = intent.getBooleanExtra(RecoveryConstants.EXTRA_IS_DOWNGRADE, false);
      if (target <= 0) {
        Log.e(RecoveryConstants.TAG, "Ignoring invalid pending ASG install target " + target);
        return;
      }
      if (!new AsgInstallTransactionStore(context).begin(target, sha256, downgrade)) {
        Log.e(RecoveryConstants.TAG, "Could not persist pending ASG install target " + target);
        return;
      }
      OneTimeWorkRequest retry =
          new OneTimeWorkRequest.Builder(AsgInstallRetryWorker.class)
              .setInitialDelay(RecoveryConstants.ASG_INSTALL_RETRY_DELAY_MS, TimeUnit.MILLISECONDS)
              .build();
      WorkManager.getInstance(context)
          .enqueueUniqueWork(
              RecoveryConstants.UNIQUE_ASG_INSTALL_RETRY_WORK,
              ExistingWorkPolicy.REPLACE,
              retry);
      setResultCode(Activity.RESULT_OK);
      Log.i(RecoveryConstants.TAG, "Stored pending ASG install target " + target);
      BootReceiver.startRecoveryService(context);
    } else if (RecoveryConstants.ACTION_ASG_INSTALL_READY.equals(intent.getAction())) {
      long target = intent.getLongExtra(RecoveryConstants.EXTRA_TARGET_ASG_VERSION, -1L);
      if (new AsgInstallTransactionStore(context).markReady(target)) {
        setResultCode(Activity.RESULT_OK);
        Log.i(RecoveryConstants.TAG, "Armed reset-complete ASG install target " + target);
      } else {
        Log.e(RecoveryConstants.TAG, "Refusing to arm unknown ASG install target " + target);
      }
    } else if (RecoveryConstants.ACTION_ASG_INSTALL_CANCEL.equals(intent.getAction())) {
      long target = intent.getLongExtra(RecoveryConstants.EXTRA_TARGET_ASG_VERSION, -1L);
      if (new AsgInstallTransactionStore(context).cancel(target)) {
        WorkManager.getInstance(context)
            .cancelUniqueWork(RecoveryConstants.UNIQUE_ASG_INSTALL_RETRY_WORK);
        setResultCode(Activity.RESULT_OK);
        Log.i(RecoveryConstants.TAG, "Cancelled pending ASG install target " + target);
      } else {
        Log.w(RecoveryConstants.TAG, "Ignoring cancel for unknown ASG install target " + target);
      }
    } else if (RecoveryConstants.ACTION_START_RECOVERY.equals(intent.getAction())) {
      Log.i(RecoveryConstants.TAG, "Starting RecoveryService from ACTION_START_RECOVERY");
      BootReceiver.startRecoveryService(context);
    }
  }
}
