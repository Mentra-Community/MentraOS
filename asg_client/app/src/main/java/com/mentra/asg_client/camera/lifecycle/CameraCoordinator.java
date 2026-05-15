package com.mentra.asg_client.camera.lifecycle;

import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraDevice;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Log;

import java.util.Timer;
import java.util.TimerTask;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;

/** Coordinates camera-adjacent lifecycle resources that outlive a single capture. */
public final class CameraCoordinator {

    private static final String TAG = "CameraCoordinator";

    private HandlerThread backgroundThread;
    private Handler backgroundHandler;
    private CameraDevice device;
    private CameraCaptureSession session;
    private Timer keepAliveTimer;
    private volatile boolean cameraKeptAlive;
    private final Semaphore openCloseLock = new Semaphore(1);

    public Handler startBackgroundThread(String name) {
        backgroundThread = new HandlerThread(name);
        backgroundThread.start();
        backgroundHandler = new Handler(backgroundThread.getLooper());
        return backgroundHandler;
    }

    public Handler backgroundHandler() {
        return backgroundHandler;
    }

    public void stopBackgroundThread() {
        if (backgroundThread == null) {
            return;
        }
        backgroundThread.quitSafely();
        try {
            backgroundThread.join();
            backgroundThread = null;
            backgroundHandler = null;
        } catch (InterruptedException e) {
            Log.e(TAG, "Interrupted when stopping background thread", e);
            Thread.currentThread().interrupt();
        }
    }

    public boolean isCameraKeptAlive() {
        return cameraKeptAlive;
    }

    public void markCameraClosed() {
        cameraKeptAlive = false;
    }

    public CameraDevice device() {
        return device;
    }

    public void setDevice(CameraDevice device) {
        this.device = device;
    }

    public void clearDevice() {
        device = null;
    }

    public CameraCaptureSession session() {
        return session;
    }

    public void setSession(CameraCaptureSession session) {
        this.session = session;
    }

    public void clearSession() {
        session = null;
    }

    public boolean hasConfiguredCamera() {
        return device != null && session != null;
    }

    public void closeDeviceAndSession() {
        if (session != null) {
            session.close();
            session = null;
        }
        if (device != null) {
            device.close();
            device = null;
        }
    }

    public void startKeepAlive(long delayMs, BooleanSupplier shouldExtend, Runnable onExpire) {
        Log.d(TAG, "Starting camera keep-alive timer for " + delayMs + "ms");
        cancelKeepAlive();
        cameraKeptAlive = true;
        keepAliveTimer = new Timer();
        keepAliveTimer.schedule(new TimerTask() {
            @Override
            public void run() {
                Runnable expiry = () -> {
                    if (shouldExtend.getAsBoolean()) {
                        Log.w(TAG, "Keep-alive expired but capture in progress - extending timer");
                        startKeepAlive(delayMs, shouldExtend, onExpire);
                        return;
                    }
                    Log.d(TAG, "Camera keep-alive timer expired");
                    cameraKeptAlive = false;
                    onExpire.run();
                };
                Handler handler = backgroundHandler;
                if (handler != null) {
                    handler.post(expiry);
                } else {
                    expiry.run();
                }
            }
        }, delayMs);
    }

    public void cancelKeepAlive() {
        if (keepAliveTimer != null) {
            Log.d(TAG, "Cancelling camera keep-alive timer");
            keepAliveTimer.cancel();
            keepAliveTimer = null;
        }
    }

    public boolean closeIfKeptAlive(Runnable closeAction) {
        if (!cameraKeptAlive) {
            return false;
        }
        cancelKeepAlive();
        cameraKeptAlive = false;
        closeAction.run();
        return true;
    }

    public boolean tryAcquireOpenCloseLock(long timeoutMs) throws InterruptedException {
        return openCloseLock.tryAcquire(timeoutMs, TimeUnit.MILLISECONDS);
    }

    public void releaseOpenCloseLock() {
        openCloseLock.release();
    }
}
