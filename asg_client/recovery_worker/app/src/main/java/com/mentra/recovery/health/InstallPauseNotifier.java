package com.mentra.recovery.health;

/**
 * In-process install pause signaling between {@link com.mentra.recovery.work.RecoveryWorker} and
 * {@link com.mentra.recovery.service.RecoveryService}. Avoids permission-gated broadcasts for
 * same-package control, which break while ASG is uninstalled during backup reinstall.
 */
public final class InstallPauseNotifier {
  public interface Listener {
    void onInstallPauseChanged(boolean paused);
  }

  private static volatile Listener listener;

  private InstallPauseNotifier() {}

  public static void setListener(Listener value) {
    listener = value;
  }

  public static void clearListener() {
    listener = null;
  }

  public static void notifyInstallInProgress() {
    Listener active = listener;
    if (active != null) {
      active.onInstallPauseChanged(true);
    }
  }

  public static void notifyInstallCompleted() {
    Listener active = listener;
    if (active != null) {
      active.onInstallPauseChanged(false);
    }
  }
}
