package com.mentra.asg_client.io.streaming.services;

import android.graphics.Matrix;
import android.opengl.GLES20;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import org.webrtc.CapturerObserver;
import org.webrtc.GlUtil;
import org.webrtc.SurfaceTextureHelper;
import org.webrtc.TextureBufferImpl;
import org.webrtc.ThreadUtils;
import org.webrtc.VideoFrame;
import org.webrtc.YuvConverter;

/**
 * Keeps a WHIP video track flowing while its camera is lent to a still capture.
 *
 * <p>Frames are black RGB textures on the capture thread's EGL context rather than I420 buffers:
 * the hardware encoder stays in surface mode, so neither the start nor the end of the photo forces
 * a codec reset. Timestamps continue the camera's own clock from its last forwarded frame, so the
 * reopened camera's first frame lands after the last substitute frame instead of jumping back.
 *
 * <p>All GL and observer work runs on the {@link SurfaceTextureHelper}'s handler thread, the same
 * thread that delivers camera frames.
 */
final class WhipFillerFrameSource {

    private static final String TAG = "WhipFillerFrameSource";
    private static final int TEXTURE_EDGE = 4;

    private final Handler mHandler;
    private final CapturerObserver mObserver;
    private final int mWidth;
    private final int mHeight;
    private final int mRotation;
    private final long mIntervalMs;
    private final long mBaseTimestampNs;
    private final long mBaseClockNs;
    private final Runnable mTick = this::tick;

    // Handler thread only.
    private boolean mRunning;
    private boolean mReleased;
    private int mTextureId;
    private YuvConverter mYuvConverter;
    private long mFramesSent;
    private long mLastTimestampNs;

    /**
     * @param lastCameraTimestampNs timestamp of the camera's last forwarded frame, or 0 if none
     * @param lastCameraClockNs {@link System#nanoTime()} when that frame was forwarded
     */
    WhipFillerFrameSource(
            SurfaceTextureHelper helper,
            CapturerObserver observer,
            int width,
            int height,
            int rotation,
            int fps,
            long lastCameraTimestampNs,
            long lastCameraClockNs) {
        mHandler = helper.getHandler();
        mObserver = observer;
        mWidth = Math.max(2, width);
        mHeight = Math.max(2, height);
        mRotation = rotation;
        mIntervalMs = Math.max(1L, 1000L / Math.max(1, fps));
        long now = System.nanoTime();
        mBaseTimestampNs = lastCameraTimestampNs > 0 ? lastCameraTimestampNs : now;
        mBaseClockNs = lastCameraTimestampNs > 0 ? lastCameraClockNs : now;
    }

    /** Begin pushing frames. Idempotent. */
    void start() {
        mHandler.post(
                () -> {
                    if (mRunning || mReleased) return;
                    try {
                        ensureTexture();
                    } catch (RuntimeException e) {
                        Log.e(TAG, "Could not create the substitute frame texture", e);
                        return;
                    }
                    mRunning = true;
                    Log.i(
                            TAG,
                            "Substitute frames started "
                                    + mWidth
                                    + "x"
                                    + mHeight
                                    + " rot="
                                    + mRotation
                                    + " every "
                                    + mIntervalMs
                                    + "ms");
                    tick();
                });
    }

    /**
     * Stop pushing frames and free the texture. Runs inline when already on the capture thread, so
     * a camera frame handler can stop substitutes before the next one is scheduled; otherwise waits
     * for the capture thread so the caller may dispose the helper right after.
     */
    void release() {
        if (Looper.myLooper() == mHandler.getLooper()) {
            releaseOnHandler();
            return;
        }
        try {
            ThreadUtils.invokeAtFrontUninterruptibly(
                    mHandler,
                    () -> {
                        releaseOnHandler();
                        return null;
                    });
        } catch (RuntimeException e) {
            // The helper's looper already quit; its EGL context took the texture with it.
            Log.w(TAG, "Capture thread gone before substitute frames were released", e);
        }
    }

    private void releaseOnHandler() {
        if (mReleased) return;
        mReleased = true;
        mRunning = false;
        mHandler.removeCallbacks(mTick);
        if (mTextureId != 0) {
            GLES20.glDeleteTextures(1, new int[] {mTextureId}, 0);
            mTextureId = 0;
        }
        if (mYuvConverter != null) {
            mYuvConverter.release();
            mYuvConverter = null;
        }
        Log.i(TAG, "Substitute frames stopped after " + mFramesSent + " frames");
    }

    private void ensureTexture() {
        if (mTextureId != 0) return;
        mTextureId = GlUtil.generateTexture(GLES20.GL_TEXTURE_2D);
        ByteBuffer black =
                ByteBuffer.allocateDirect(TEXTURE_EDGE * TEXTURE_EDGE * 4)
                        .order(ByteOrder.nativeOrder());
        for (int i = 0; i < TEXTURE_EDGE * TEXTURE_EDGE; i++) {
            black.put((byte) 0).put((byte) 0).put((byte) 0).put((byte) 0xff);
        }
        black.flip();
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, mTextureId);
        GLES20.glTexImage2D(
                GLES20.GL_TEXTURE_2D,
                0,
                GLES20.GL_RGBA,
                TEXTURE_EDGE,
                TEXTURE_EDGE,
                0,
                GLES20.GL_RGBA,
                GLES20.GL_UNSIGNED_BYTE,
                black);
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, 0);
        // The encoder samples this texture from its own shared context.
        GLES20.glFinish();
        GlUtil.checkNoGLES2Error("WhipFillerFrameSource.ensureTexture");
        mYuvConverter = new YuvConverter();
    }

    private void tick() {
        if (!mRunning || mReleased) return;
        long timestampNs = mBaseTimestampNs + (System.nanoTime() - mBaseClockNs);
        if (timestampNs <= mLastTimestampNs) timestampNs = mLastTimestampNs + 1;
        mLastTimestampNs = timestampNs;
        TextureBufferImpl buffer =
                new TextureBufferImpl(
                        mWidth,
                        mHeight,
                        VideoFrame.TextureBuffer.Type.RGB,
                        mTextureId,
                        new Matrix(),
                        mHandler,
                        mYuvConverter,
                        (Runnable) null);
        VideoFrame frame = new VideoFrame(buffer, mRotation, timestampNs);
        try {
            mObserver.onFrameCaptured(frame);
            mFramesSent++;
        } finally {
            frame.release();
        }
        mHandler.postDelayed(mTick, mIntervalMs);
    }
}
