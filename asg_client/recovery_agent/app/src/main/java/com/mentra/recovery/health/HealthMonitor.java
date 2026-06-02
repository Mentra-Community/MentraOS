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

  private final Runnable heartbeatTick = new Runnable() {
    @Override
    public void run() {
      if (!paused) {
        sendPing();
        long delta = System.currentTimeMillis() - lastPongAt;
        if (delta > RecoveryConstants.HEARTBEAT_TIMEOUT_MS) {
          missedHeartbeats++;
          Log.w(
              RecoveryConstants.TAG,
              "Missed heartbeat count="
                  + missedHeartbeats
                  + " deltaMs="
                  + delta
                  + " timeoutMs="
                  + RecoveryConstants.HEARTBEAT_TIMEOUT_MS);
          if (missedHeartbeats >= RecoveryConstants.MAX_MISSED_HEARTBEATS) {
            Log.w(RecoveryConstants.TAG, "ASG considered unresponsive; triggering recovery");
            listener.onAsgUnresponsive();
            missedHeartbeats = 0;
          }
        }
      }
      handler.postDelayed(this, RecoveryConstants.HEARTBEAT_INTERVAL_MS);
    }
  };

  public HealthMonitor(Context context, Listener listener) {
    this.context = context.getApplicationContext();
    this.listener = listener;
    this.handler = new Handler(Looper.getMainLooper());
  }

  public void start() {
    lastPongAt = System.currentTimeMillis();
    missedHeartbeats = 0;
    Log.i(RecoveryConstants.TAG, "HealthMonitor started");
    handler.postDelayed(heartbeatTick, RecoveryConstants.HEARTBEAT_INTERVAL_MS);
  }

  public void stop() {
    Log.i(RecoveryConstants.TAG, "HealthMonitor stopped");
    handler.removeCallbacksAndMessages(null);
  }

  public void onPong() {
    lastPongAt = System.currentTimeMillis();
    missedHeartbeats = 0;
    Log.i(RecoveryConstants.TAG, "Received PONG from ASG");
  }

  public void setPaused(boolean paused) {
    this.paused = paused;
    Log.i(RecoveryConstants.TAG, "HealthMonitor paused=" + paused);
  }

  private void sendPing() {
    Log.d(RecoveryConstants.TAG, "Sending PING to ASG");
    Intent ping = new Intent(RecoveryConstants.ACTION_PING);
    ping.setPackage(RecoveryConstants.ASG_PACKAGE);
    ping.addFlags(Intent.FLAG_INCLUDE_STOPPED_PACKAGES);
    context.sendBroadcast(ping);
  }
}
