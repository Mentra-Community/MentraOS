package com.mentra.recovery.health;

import android.os.SystemClock;

import com.mentra.recovery.util.RecoveryConstants;

/**
 * In-process install pause signaling between {@link com.mentra.recovery.work.RecoveryWorker} and
 * {@link com.mentra.recovery.service.RecoveryService}. Avoids permission-gated broadcasts for
 * same-package control, which break while ASG is uninstalled during backup reinstall.
 *
 * <p>Also exposes a readable {@link #isInstallPaused()} flag so recovery-side install paths can
 * defer while an ASG-driven install is in flight, avoiding racing installs. The pause self-expires
 * after {@link RecoveryConstants#INSTALL_PAUSE_MAX_MS} so a missing completion signal (e.g. a
 * stuck/failed ASG OTA that never broadcasts {@code ACTION_INSTALL_COMPLETED}) cannot pause
 * recovery indefinitely. This mirrors the HealthMonitor pause watchdog.
 */
public final class InstallPauseNotifier {
  public interface Listener {
    void onInstallPauseChanged(boolean paused);
  }

  private static volatile Listener listener;
  /** Monotonic deadline after which the pause auto-expires; {@code 0} means not paused. */
  private static volatile long pauseExpiryMs = 0L;

  private InstallPauseNotifier() {}

  public static void setListener(Listener value) {
    listener = value;
  }

  public static void clearListener() {
    listener = null;
  }

  /** True while an install (ASG OTA or recovery backup reinstall) is in progress. */
  public static boolean isInstallPaused() {
    long expiry = pauseExpiryMs;
    if (expiry == 0L) {
      return false;
    }
    if (SystemClock.elapsedRealtime() >= expiry) {
      pauseExpiryMs = 0L;
      return false;
    }
    return true;
  }

  /** Reflects an install-pause signal observed by {@code RecoveryService} (e.g. ASG OTA). */
  public static void setInstallPaused(boolean paused) {
    pauseExpiryMs =
        paused ? SystemClock.elapsedRealtime() + RecoveryConstants.INSTALL_PAUSE_MAX_MS : 0L;
  }

  public static void notifyInstallInProgress() {
    setInstallPaused(true);
    Listener active = listener;
    if (active != null) {
      active.onInstallPauseChanged(true);
    }
  }

  public static void notifyInstallCompleted() {
    setInstallPaused(false);
    Listener active = listener;
    if (active != null) {
      active.onInstallPauseChanged(false);
    }
  }
}
