package com.mentra.recovery.health;

import java.util.concurrent.atomic.AtomicBoolean;

/**
 * In-process install pause signaling between {@link com.mentra.recovery.work.RecoveryWorker} and
 * {@link com.mentra.recovery.service.RecoveryService}. Avoids permission-gated broadcasts for
 * same-package control, which break while ASG is uninstalled during backup reinstall.
 *
 * <p>Also exposes a readable {@link #isInstallPaused()} flag so the remediation worker can defer
 * its own download/install while an ASG-driven install is in flight, avoiding racing installs.
 */
public final class InstallPauseNotifier {
  public interface Listener {
    void onInstallPauseChanged(boolean paused);
  }

  private static volatile Listener listener;
  private static final AtomicBoolean installPaused = new AtomicBoolean(false);

  private InstallPauseNotifier() {}

  public static void setListener(Listener value) {
    listener = value;
  }

  public static void clearListener() {
    listener = null;
  }

  /** True while an install (ASG OTA or recovery reinstall/remediation) is in progress. */
  public static boolean isInstallPaused() {
    return installPaused.get();
  }

  /** Reflects an install-pause signal observed by {@code RecoveryService} (e.g. ASG OTA). */
  public static void setInstallPaused(boolean paused) {
    installPaused.set(paused);
  }

  public static void notifyInstallInProgress() {
    installPaused.set(true);
    Listener active = listener;
    if (active != null) {
      active.onInstallPauseChanged(true);
    }
  }

  public static void notifyInstallCompleted() {
    installPaused.set(false);
    Listener active = listener;
    if (active != null) {
      active.onInstallPauseChanged(false);
    }
  }
}
