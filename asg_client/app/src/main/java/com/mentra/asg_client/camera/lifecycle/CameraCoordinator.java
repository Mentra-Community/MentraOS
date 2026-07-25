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
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.BooleanSupplier;

/** Coordinates camera-adjacent lifecycle resources that outlive a single capture. */
public final class CameraCoordinator {

    private static final String TAG = "CameraCoordinator";

    /**
     * Coarse camera lifecycle, tracked for logging and stale-callback detection. The
     * authoritative guard is {@link #generation()}: every open attempt and every
     * device/session close bump it, and async work captures the generation it was
     * issued under so late callbacks can detect that the camera they belong to is gone
     * (or worse, replaced — a null-check cannot tell a reopened camera from its own).
     */
    public enum LifecycleState {
        CLOSED,
        OPENING,
        OPENED,
        CONFIGURED
    }

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
    private volatile LifecycleState state = LifecycleState.CLOSED;
    private final AtomicLong generation = new AtomicLong();

    public LifecycleState state() {
        return state;
    }

    /** The current camera generation; see {@link LifecycleState}. */
    public long generation() {
        return generation.get();
    }

    /** Whether async work issued under {@code observedGeneration} still owns the camera. */
    public boolean isCurrentGeneration(long observedGeneration) {
        return generation.get() == observedGeneration;
    }

    /**
     * Marks the start of a new open attempt and returns its generation. Callbacks of
     * this open must capture the returned value and drop themselves via
     * {@link #isCurrentGeneration} once a newer open or a close has superseded them.
     */
    public long beginOpen() {
        state = LifecycleState.OPENING;
        long next = generation.incrementAndGet();
        Log.d(TAG, "Camera open attempt, generation " + next);
        return next;
    }

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
        state = LifecycleState.OPENED;
    }

    public void clearDevice() {
        device = null;
        state = LifecycleState.CLOSED;
    }

    public CameraCaptureSession session() {
        return session;
    }

    public void setSession(CameraCaptureSession session) {
        this.session = session;
        state = LifecycleState.CONFIGURED;
    }

    public void clearSession() {
        session = null;
    }

    public boolean hasConfiguredCamera() {
        return device != null && session != null;
    }

    public void closeDeviceAndSession() {
        // Bump first: anything still in flight for the old camera must see itself
        // stale before the device handles start closing.
        generation.incrementAndGet();
        state = LifecycleState.CLOSED;
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
        // The expiry closes the camera this keep-alive was armed for — not whatever
        // camera exists when it finally runs. Timer.cancel() cannot dequeue an expiry
        // already posted to the camera thread, so a close+reopen (or a capture that
        // cancelled this timer) otherwise gets its fresh camera torn down by a stale
        // expiry.
        long armedGeneration = generation.get();
        keepAliveTimer = new Timer();
        keepAliveTimer.schedule(new TimerTask() {
            @Override
            public void run() {
                Runnable expiry = () -> {
                    if (!isCurrentGeneration(armedGeneration)) {
                        Log.d(TAG, "Keep-alive expiry is stale (camera reopened); skipping");
                        return;
                    }
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
