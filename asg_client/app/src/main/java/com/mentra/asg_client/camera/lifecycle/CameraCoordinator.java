package com.mentra.asg_client.camera.lifecycle;

import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraDevice;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Log;

import java.util.Timer;
import java.util.TimerTask;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;

/** Coordinates camera-adjacent lifecycle resources that outlive a single capture. */
public final class CameraCoordinator {

    private static final String TAG = "CameraCoordinator";

    // Volatile: mutated on the camera thread but still read from caller threads
    // (advisory state checks, keep-alive TimerTask) — plain fields gave those
    // readers no visibility guarantee at all.
    private volatile HandlerThread backgroundThread;
    private volatile Handler backgroundHandler;
    private volatile CameraDevice device;
    private volatile CameraCaptureSession session;
    private volatile Timer keepAliveTimer;
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

    /**
     * Runs {@code action} on the camera background thread, where all camera lifecycle
     * mutations (device, session, readers, recorder) belong — Camera2 already delivers
     * the open/session callbacks there, so posting serializes teardown against setup
     * without locks. Runs inline when already on the camera thread, and also when the
     * thread is gone (service teardown) so a close is never dropped.
     */
    public void runOnCameraThread(Runnable action) {
        Handler handler = backgroundHandler;
        if (handler == null || handler.getLooper().isCurrentThread()) {
            action.run();
            return;
        }
        if (!handler.post(action)) {
            // Looper is quitting; teardown work must still happen.
            action.run();
        }
    }

    /**
     * Like {@link #runOnCameraThread} but waits up to {@code timeoutMs} for the action
     * to finish. For callers that need the camera actually released before proceeding
     * (e.g. evicting a kept-alive camera before starting video). Returns false when the
     * wait timed out or was interrupted; the action still runs in that case, just later.
     * Never call while holding a lock the action also takes.
     */
    public boolean awaitOnCameraThread(Runnable action, long timeoutMs) {
        Handler handler = backgroundHandler;
        if (handler == null || handler.getLooper().isCurrentThread()) {
            action.run();
            return true;
        }
        CountDownLatch done = new CountDownLatch(1);
        boolean posted =
                handler.post(
                        () -> {
                            try {
                                action.run();
                            } finally {
                                done.countDown();
                            }
                        });
        if (!posted) {
            action.run();
            return true;
        }
        try {
            return done.await(timeoutMs, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
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
                    // A null handler means the camera thread was already stopped, which
                    // only happens on service teardown — the camera is closed (or being
                    // closed) by that path. Running the teardown here would mutate camera
                    // state on a raw Timer thread.
                    Log.w(TAG, "Keep-alive expired after camera thread stopped; skipping");
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
