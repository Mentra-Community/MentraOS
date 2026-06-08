package com.mentra.recovery.health;

import android.content.Context;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import com.mentra.recovery.util.RecoveryConstants;

public class HealthMonitor {
  public interface Listener {
    void onAsgUnresponsive();
  }

  private final Context context;
  private final Handler handler;
  private final Listener listener;
  private int missedHeartbeats = 0;
  private long lastPongAt = System.currentTimeMillis();
  private boolean paused = false;
  private long currentIntervalMs = RecoveryConstants.HEARTBEAT_INTERVAL_MS;

  private final Runnable pauseWatchdog =
      new Runnable() {
        @Override
        public void run() {
          if (!paused) {
            return;
          }
          Log.w(
              RecoveryConstants.TAG,
              "Install pause exceeded "
                  + RecoveryConstants.INSTALL_PAUSE_MAX_MS
                  + "ms without completion; resuming heartbeat monitoring");
          setPaused(false);
        }
      };

  private final Runnable heartbeatTick =
      new Runnable() {
        @Override
        public void run() {
          if (!paused) {
            sendPing();
            long delta = System.currentTimeMillis() - lastPongAt;
            long timeoutMs = getTimeoutMs();
            if (delta > timeoutMs) {
              missedHeartbeats++;
              useFastCadence();
              Log.w(
                  RecoveryConstants.TAG,
                  "Missed heartbeat count="
                      + missedHeartbeats
                      + " deltaMs="
                      + delta
                      + " timeoutMs="
                      + timeoutMs
                      + " intervalMs="
                      + currentIntervalMs);
              if (missedHeartbeats >= RecoveryConstants.MAX_MISSED_HEARTBEATS) {
                Log.w(RecoveryConstants.TAG, "ASG considered unresponsive; triggering recovery");
                listener.onAsgUnresponsive();
                missedHeartbeats = 0;
              }
            }
          }
          scheduleNextTick();
        }
      };

  public HealthMonitor(Context context, Listener listener) {
    this.context = context.getApplicationContext();
    this.listener = listener;
    this.handler = new Handler(Looper.getMainLooper());
  }

  public void start() {
    resetHeartbeatCadence();
    Log.i(RecoveryConstants.TAG, "HealthMonitor started");
    scheduleNextTick();
  }

  public void stop() {
    Log.i(RecoveryConstants.TAG, "HealthMonitor stopped");
    handler.removeCallbacksAndMessages(null);
  }

  public void onPong() {
    resetHeartbeatCadence();
    Log.i(RecoveryConstants.TAG, "Received PONG from ASG");
  }

  public void setPaused(boolean paused) {
    handler.removeCallbacks(pauseWatchdog);
    this.paused = paused;
    if (!paused) {
      resetHeartbeatCadence();
      scheduleNextTick();
    } else {
      handler.removeCallbacks(heartbeatTick);
      handler.postDelayed(pauseWatchdog, RecoveryConstants.INSTALL_PAUSE_MAX_MS);
    }
    Log.i(RecoveryConstants.TAG, "HealthMonitor paused=" + paused);
  }

  /** Restores the normal 20s cadence after recovery or a successful pong. */
  public void resetHeartbeatCadence() {
    currentIntervalMs = RecoveryConstants.HEARTBEAT_INTERVAL_MS;
    lastPongAt = System.currentTimeMillis();
    missedHeartbeats = 0;
  }

  private long getTimeoutMs() {
    return currentIntervalMs == RecoveryConstants.HEARTBEAT_FAST_INTERVAL_MS
        ? RecoveryConstants.HEARTBEAT_FAST_TIMEOUT_MS
        : RecoveryConstants.HEARTBEAT_TIMEOUT_MS;
  }

  private void useFastCadence() {
    if (currentIntervalMs != RecoveryConstants.HEARTBEAT_FAST_INTERVAL_MS) {
      currentIntervalMs = RecoveryConstants.HEARTBEAT_FAST_INTERVAL_MS;
      Log.i(
          RecoveryConstants.TAG,
          "Accelerating heartbeat interval to " + currentIntervalMs + "ms after miss");
    }
  }

  private void scheduleNextTick() {
    handler.removeCallbacks(heartbeatTick);
    handler.postDelayed(heartbeatTick, currentIntervalMs);
  }

  private void sendPing() {
    Log.d(RecoveryConstants.TAG, "Sending PING to ASG");
    Intent ping = new Intent(RecoveryConstants.ACTION_PING);
    ping.setPackage(RecoveryConstants.ASG_PACKAGE);
    ping.addFlags(Intent.FLAG_INCLUDE_STOPPED_PACKAGES);
    context.sendBroadcast(ping, RecoveryConstants.RECOVERY_HEARTBEAT_PERMISSION);
  }
}
