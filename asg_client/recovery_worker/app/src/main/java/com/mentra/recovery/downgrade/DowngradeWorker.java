package com.mentra.recovery.downgrade;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.os.Build;
import android.os.SystemClock;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import com.mentra.recovery.health.InstallPauseNotifier;
import com.mentra.recovery.telemetry.RecoveryTelemetry;
import com.mentra.recovery.util.RecoveryConstants;
import com.mentra.recovery.util.SystemInstaller;

import java.io.File;
import java.io.FileInputStream;
import java.security.MessageDigest;
import java.util.Set;
import java.util.TreeSet;

/**
 * Drives one persisted pinned-downgrade transaction to convergence.
 *
 * <p>The OEM installer refuses lower-versionCode installs, so a downgrade takes the detour:
 * uninstall the ASG system-app update (reverts to the passive factory {@code /system} build and
 * wipes ASG {@code /data/data} — the deterministic state reset a downgrade requires), then install
 * the staged target APK, which is an ordinary upgrade from the factory floor. Every step is derived
 * from observable package state, so the worker is safe to re-run after process death, reboot, or a
 * lost broadcast at any point.
 *
 * <p><b>Reliability invariant — where correctness lives.</b> The OEM installer is an asynchronous
 * broadcast with no completion callback and no cancellation, so no glasses-side protocol (locks,
 * observe windows, the convergence linger) can close every race — they only bound how long a
 * divergence can last. Correctness is therefore NOT claimed here: it lives in the phone's
 * reconciliation loop, which compares {@code version_info} against the pinned manifest on every
 * connect and poll, and re-offers the pin whenever they differ. Every glasses-side race, however
 * exotic, resolves to at-most-temporary divergence that the next phone check heals. Review changes
 * to this package against that frame: a new race window is a latency/UX bug, not a correctness
 * bug, PROVIDED nothing here installs a build the phone did not sanction (the sole exception is
 * heartbeat recovery's backup reinstall, which exists precisely for the ASG-dead case where no
 * phone channel is possible, and which serializes with this transaction via the install lock).
 *
 * <p>If the transaction gives up after the revert, the device is left on the factory build with the
 * transaction cleared. There is deliberately no autonomous path back to a fleet build: the factory
 * build is a functioning, pairable baseline, and on the next phone connection the version check
 * sees factory != pin and re-offers the target through the normal phone-driven flow — which from
 * the factory floor is a plain OEM upgrade install, a simpler and independently exercised
 * mechanism than the recovery-side install that just failed. Heartbeat recovery does not fight
 * this state either: a responsive factory ASG is healthy, so the fleet backup is not reinstalled
 * over it.
 */
public class DowngradeWorker extends Worker {

  public DowngradeWorker(@NonNull Context context, @NonNull WorkerParameters params) {
    super(context, params);
  }

  @NonNull
  @Override
  public Result doWork() {
    Context context = getApplicationContext();
    DowngradeTransactionStore store = new DowngradeTransactionStore(context);
    if (!store.isActive()) {
      return Result.success();
    }

    RecoveryTelemetry telemetry = new RecoveryTelemetry(context);
    long target = store.getTargetVersion();
    int attempt = getRunAttemptCount();

    if (System.currentTimeMillis() - store.getStartedAtMs()
        > RecoveryConstants.DOWNGRADE_TRANSACTION_STALE_MS) {
      return giveUp(store, telemetry, target, "TRANSACTION_STALE", attempt);
    }

    // Serialize with heartbeat recovery's reinstall: RecoveryWorker holds this lock across its
    // liveness check, backup-install dispatch, AND a bounded wait for that install to be
    // observed. Taking it here (WorkManager thread — blocking is fine) means this state machine
    // never starts while a higher backup install is in flight; combined with WAIT_FOR_REVERT
    // re-dispatching the uninstall whenever a higher build (re)appears, a stale install cannot
    // defeat the pin.
    DowngradeTransactionStore.installLock().lock();
    // Pause heartbeat monitoring for the whole detour so the uninstall/install windows are not
    // mistaken for an ASG crash and remediated mid-transaction.
    InstallPauseNotifier.notifyInstallInProgress();
    try {
      SystemInstaller installer = new SystemInstaller(context);
      while (true) {
        long installed = installedAsgVersion(context);
        DowngradePlan.Action action =
            DowngradePlan.nextAction(
                installed,
                target,
                store.isUninstallRequested(),
                store.getInstallAttempts(),
                RecoveryConstants.DOWNGRADE_MAX_INSTALL_ATTEMPTS);
        Log.i(
            RecoveryConstants.TAG,
            "Downgrade step: installed=" + installed + ", target=" + target + " -> " + action);

        switch (action) {
          case ALREADY_AT_TARGET:
            // Linger before clearing: an OEM install dispatched earlier (e.g. a recovery backup
            // reinstall that outlived its observe window) commits asynchronously and could land
            // right after convergence — with the transaction cleared there would be no
            // WAIT_FOR_REVERT left to re-uninstall it. Keep the transaction alive for a bounded
            // window re-checking the version; any change resumes the state machine, which
            // re-derives (higher build -> re-uninstall) instead of completing.
            if (!versionHeldThroughLinger(context, target)) {
              Log.w(
                  RecoveryConstants.TAG,
                  "Installed version moved off target during convergence linger; resuming");
              continue;
            }
            deleteStagedApk(store);
            store.clear();
            telemetry.emit(
                "mentra_downgrade_applied", String.valueOf(target), "VERSION_CONVERGED", attempt, true);
            return Result.success();

          case SEND_UNINSTALL:
            // Validate the staged APK BEFORE the first mutation: if it is unusable, abort with
            // the current build still installed and untouched.
            if (!isStagedApkValid(context, store)) {
              return giveUp(store, telemetry, target, "STAGED_APK_INVALID", attempt);
            }
            store.markUninstallRequested();
            // fall through to dispatch + wait
          case WAIT_FOR_REVERT:
            // Re-dispatching the uninstall is harmless while still above target and self-heals a
            // broadcast lost to process death between persist and dispatch.
            installer.uninstallPackage(RecoveryConstants.ASG_PACKAGE);
            // Wait for a REAL lower installed build (the factory floor), not just "below target":
            // mid-uninstall the package is briefly unresolved (installedAsgVersion == -1), which
            // is below target but is NOT the factory build being present. Dispatching SEND_INSTALL
            // then would race the still-in-flight OEM uninstall.
            if (!waitForInstalledVersion(
                context,
                v -> v > 0 && v < target,
                RecoveryConstants.DOWNGRADE_REVERT_TIMEOUT_MS)) {
              Log.w(RecoveryConstants.TAG, "Factory revert not observed in time; will retry");
              return Result.retry();
            }
            break;

          case SEND_INSTALL:
            // Re-validate against the archive only: after the revert the wipe is already done, so
            // an unusable APK here means giving up to the factory build (the phone re-offers
            // the pin as a plain upgrade on its next check).
            if (!isStagedApkValid(context, store)) {
              return giveUp(store, telemetry, target, "STAGED_APK_INVALID_POST_REVERT", attempt);
            }
            store.incrementInstallAttempts();
            installer.installApk(store.getApkPath(), RecoveryConstants.ASG_PACKAGE);
            if (!waitForInstalledVersion(
                context, v -> v == target, RecoveryConstants.DOWNGRADE_INSTALL_TIMEOUT_MS)) {
              Log.w(
                  RecoveryConstants.TAG,
                  "Target version not observed after install dispatch "
                      + store.getInstallAttempts()
                      + "; re-evaluating");
            }
            break;

          case GIVE_UP:
          default:
            return giveUp(store, telemetry, target, "INSTALL_ATTEMPTS_EXHAUSTED", attempt);
        }
      }
    } finally {
      InstallPauseNotifier.notifyInstallCompleted();
      DowngradeTransactionStore.installLock().unlock();
    }
  }

  private void deleteStagedApk(DowngradeTransactionStore store) {
    String path = store.getApkPath();
    if (path == null || path.isEmpty()) {
      return;
    }
    File apk = new File(path);
    if (apk.exists() && !apk.delete()) {
      Log.w(RecoveryConstants.TAG, "Failed to delete staged downgrade APK: " + path);
    }
  }

  private Result giveUp(
      DowngradeTransactionStore store,
      RecoveryTelemetry telemetry,
      long target,
      String reason,
      int attempt) {
    Log.e(RecoveryConstants.TAG, "Downgrade transaction giving up: " + reason);
    deleteStagedApk(store);
    store.clear();
    telemetry.emit("mentra_downgrade_failed", String.valueOf(target), reason, attempt, false);
    // Terminal non-ownership verdict: a give-up BEFORE the uninstall leaves the original ASG
    // installed, alive, and sitting on its long supervision timer — telemetry alone would
    // strand it (and the phone's latch) for the full 40 minutes. The verdict finds ASG's
    // armed supervision watchdog and releases everything immediately. Post-revert give-ups
    // send it too: the factory build has no verdict receiver (or no pending handoff), so the
    // broadcast is dropped harmlessly there.
    DowngradeController.sendHandoffResult(
        getApplicationContext(), false, target, "gave_up:" + reason);
    return Result.failure();
  }

  private interface VersionPredicate {
    boolean test(long installedVersion);
  }

  /**
   * True when the installed version stays exactly at {@code target} for the whole convergence
   * linger window; false the moment it changes (including briefly unresolvable — the caller's
   * re-derivation distinguishes a real regression from a transient).
   */
  private static boolean versionHeldThroughLinger(Context context, long target) {
    long deadline =
        SystemClock.elapsedRealtime() + RecoveryConstants.DOWNGRADE_CONVERGENCE_LINGER_MS;
    while (SystemClock.elapsedRealtime() < deadline) {
      SystemClock.sleep(RecoveryConstants.DOWNGRADE_LINGER_POLL_MS);
      if (installedAsgVersion(context) != target) {
        return false;
      }
    }
    return true;
  }

  private boolean waitForInstalledVersion(
      Context context, VersionPredicate predicate, long timeoutMs) {
    long deadline = SystemClock.elapsedRealtime() + timeoutMs;
    while (SystemClock.elapsedRealtime() < deadline) {
      if (predicate.test(installedAsgVersion(context))) {
        return true;
      }
      try {
        Thread.sleep(RecoveryConstants.DOWNGRADE_POLL_INTERVAL_MS);
      } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
        return false;
      }
    }
    return predicate.test(installedAsgVersion(context));
  }

  /** Installed ASG versionCode, or -1 when the package cannot be resolved. */
  private static long installedAsgVersion(Context context) {
    try {
      PackageInfo info =
          context.getPackageManager().getPackageInfo(RecoveryConstants.ASG_PACKAGE, 0);
      return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
          ? info.getLongVersionCode()
          : info.versionCode;
    } catch (PackageManager.NameNotFoundException e) {
      return -1L;
    }
  }

  /**
   * Full validation of the staged APK: readable, checksum-matched, correct package, matching
   * versionCode, not testOnly, and signed by the same signers as the installed build when one is
   * present (the factory build shares the release signers, so this holds across the revert).
   */
  private boolean isStagedApkValid(Context context, DowngradeTransactionStore store) {
    String invalid =
        StagedApkValidator.validate(
            context, store.getApkPath(), store.getApkSha256(), store.getTargetVersion());
    if (invalid != null) {
      Log.e(RecoveryConstants.TAG, "Staged downgrade APK invalid: " + invalid);
      return false;
    }
    return true;
  }





  private static Set<String> signerDigests(PackageInfo info) {
    Set<String> digests = new TreeSet<>();
    try {
      Signature[] signers = null;
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && info.signingInfo != null) {
        signers = info.signingInfo.getApkContentsSigners();
      } else if (info.signatures != null) {
        signers = info.signatures;
      }
      if (signers == null) {
        return digests;
      }
      MessageDigest digest = MessageDigest.getInstance("SHA-256");
      for (Signature signature : signers) {
        if (signature == null) {
          continue;
        }
        byte[] hash = digest.digest(signature.toByteArray());
        StringBuilder sb = new StringBuilder(hash.length * 2);
        for (byte b : hash) {
          sb.append(String.format("%02x", b));
        }
        digests.add(sb.toString());
      }
    } catch (Exception e) {
      Log.e(RecoveryConstants.TAG, "Failed to hash signer", e);
    }
    return digests;
  }
}
