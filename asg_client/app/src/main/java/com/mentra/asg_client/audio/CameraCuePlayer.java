package com.mentra.asg_client.audio;

import android.content.Context;
import android.content.res.AssetFileDescriptor;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioTrack;
import android.media.MediaPlayer;
import android.os.Handler;
import android.util.Log;

import com.mentra.asg_client.AsgConstants;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;

/** Camera-only static PCM playback, with the existing MediaPlayer path as fallback. */
final class CameraCuePlayer {
    interface CompletionListener { void onCompletion(CameraCuePlayer player); }
    interface ErrorListener { boolean onError(CameraCuePlayer player, int what, int extra); }

    /** Owned by one I2S controller and accessed under that controller's monitor. */
    static final class Pool {
        private final Context context;
        private final Handler handler;
        private final Map<String, Slot> slots = new HashMap<>();

        Pool(Context context, Handler handler) {
            this.context = context;
            this.handler = handler;
            preload(AudioAssets.CAMERA_PREP_CLICK, "camera_prep_click.wav", true);
            preload(AudioAssets.CAMERA_SNAP, AudioAssets.CAMERA_SNAP, false);
        }

        private void preload(String key, String file, boolean repeat) {
            try (InputStream input = context.getAssets().open(file);
                    ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                if (input == null) throw new IOException("missing cue asset");
                byte[] buffer = new byte[4096];
                int n;
                while ((n = input.read(buffer)) != -1) {
                    if (out.size() + n > AsgConstants.CAMERA_PCM_MAX_ASSET_BYTES) {
                        throw new IOException("cue asset exceeds preload bound");
                    }
                    out.write(buffer, 0, n);
                }
                byte[] pcm = decodeStereoPcm(out.toByteArray());
                if (repeat) {
                    int periodBytes = AsgConstants.CAMERA_PCM_SAMPLE_RATE
                            * (int) AsgConstants.CAMERA_PREP_CLICK_INTERVAL_MS / 1000 * 4;
                    if (pcm.length > periodBytes) throw new IOException("prep exceeds period");
                    pcm = Arrays.copyOf(pcm, periodBytes);
                }
                Slot slot = new Slot(pcm, repeat);
                slot.track = createTrack(slot);
                slots.put(key, slot);
            } catch (IOException | RuntimeException e) {
                // Missing assets, unsupported static tracks, and allocation failures retain
                // legacy playback. Never prevent hardware-manager/service initialization.
                Log.w("CameraCuePlayer", "PCM preload unavailable for " + key, e);
            }
        }

        private AudioTrack createTrack(Slot slot) {
            AudioTrack track = new AudioTrack.Builder()
                    .setAudioAttributes(new AudioAttributes.Builder()
                            .setLegacyStreamType(AudioManager.STREAM_NOTIFICATION).build())
                    .setAudioFormat(new AudioFormat.Builder()
                            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                            .setSampleRate(AsgConstants.CAMERA_PCM_SAMPLE_RATE)
                            .setChannelMask(AudioFormat.CHANNEL_OUT_STEREO).build())
                    .setTransferMode(AudioTrack.MODE_STATIC)
                    .setBufferSizeInBytes(slot.pcm.length)
                    .setPerformanceMode(AudioTrack.PERFORMANCE_MODE_LOW_LATENCY)
                    .build();
            try {
                if (track.getState() == AudioTrack.STATE_UNINITIALIZED
                        || track.write(slot.pcm, 0, slot.pcm.length) != slot.pcm.length) {
                    throw new IllegalStateException("static PCM load failed");
                }
                return track;
            } catch (RuntimeException e) {
                track.release();
                throw e;
            }
        }

        private Slot acquire(String asset) {
            Slot slot = slots.get(asset);
            // Preserve overlapping requests: a busy cue falls back rather than stealing
            // another token's track. Bound native resources to one cached track per asset.
            if (slot == null || slot.busy || slot.failed) return null;
            try {
                if (slot.track == null) slot.track = createTrack(slot);
                slot.busy = true;
                return slot;
            } catch (RuntimeException e) {
                slot.failed = true;
                Log.w("CameraCuePlayer", "PCM allocation failed; using MediaPlayer", e);
                return null;
            }
        }

        private void recycle(Slot slot, boolean failed) {
            slot.track.setPlaybackPositionUpdateListener(null);
            try {
                slot.track.stop();
            } catch (RuntimeException e) {
                failed = true;
            }
            slot.busy = false;
            if (failed) {
                slot.failed = true;
                slot.track.release();
                slot.track = null;
            }
        }

        void clear() {
            // Controller releases all overlay tokens before clearing its cache.
            for (Slot slot : slots.values()) {
                if (!slot.busy && slot.track != null) {
                    slot.track.release();
                    slot.track = null;
                }
            }
        }
    }

    private static final class Slot {
        final byte[] pcm;
        final boolean repeat;
        AudioTrack track;
        boolean busy;
        boolean failed;
        Slot(byte[] pcm, boolean repeat) { this.pcm = pcm; this.repeat = repeat; }
    }

    private final Pool pool;
    private final String asset;
    private final float volume;
    private Slot slot;
    private MediaPlayer media;
    private CompletionListener completion;
    private ErrorListener error;
    private volatile boolean released;
    private volatile boolean started;

    CameraCuePlayer(Pool pool, String asset, float volume) {
        this.pool = pool;
        this.asset = asset;
        this.volume = volume;
    }

    void setOnCompletionListener(CompletionListener listener) { completion = listener; }
    void setOnErrorListener(ErrorListener listener) { error = listener; }

    void prepare() throws IOException {
        slot = pool.acquire(asset);
        if (slot == null) prepareMedia();
    }

    private void prepareMedia() throws IOException {
        media = new MediaPlayer();
        media.setAudioStreamType(AudioManager.STREAM_NOTIFICATION);
        media.setVolume(volume, volume);
        try (AssetFileDescriptor afd = pool.context.getAssets().openFd(asset)) {
            media.setDataSource(afd.getFileDescriptor(), afd.getStartOffset(), afd.getLength());
        }
        media.setOnCompletionListener(mp -> {
            if (!released && completion != null) completion.onCompletion(this);
        });
        media.setOnErrorListener((mp, what, extra) ->
                released || error == null || error.onError(this, what, extra));
        media.prepare();
    }

    void start() {
        if (released) throw new IllegalStateException("released cue");
        if (slot != null) {
            try {
                AudioTrack track = slot.track;
                check(track.reloadStaticData());
                check(track.setPlaybackHeadPosition(0));
                int frames = slot.pcm.length / 4;
                int repeats = slot.repeat ? AsgConstants.CAMERA_PCM_PREP_PERIODS - 1 : 0;
                check(track.setLoopPoints(0, frames, repeats));
                check(track.setVolume(volume));
                final int endFrame = frames * (repeats + 1);
                track.setPlaybackPositionUpdateListener(new AudioTrack.OnPlaybackPositionUpdateListener() {
                    @Override public void onMarkerReached(AudioTrack ignored) {
                        if (released || !started || completion == null) return;
                        // AudioTrack can deliver a queued native marker after a track is
                        // recycled. Confirm this playback reached its end before retiring
                        // the new token; the listener identity alone is not sufficient.
                        try {
                            if (Integer.toUnsignedLong(track.getPlaybackHeadPosition()) >= endFrame) {
                                completion.onCompletion(CameraCuePlayer.this);
                            }
                        } catch (IllegalStateException e) {
                            Log.w("CameraCuePlayer", "Ignoring marker from retired track", e);
                        }
                    }
                    @Override public void onPeriodicNotification(AudioTrack ignored) {}
                }, pool.handler);
                check(track.setNotificationMarkerPosition(endFrame));
                track.play();
                started = true;
                Log.i("CameraCuePlayer", "[CAMERA-PCM] play asset=" + asset);
                return;
            } catch (RuntimeException e) {
                pool.recycle(slot, true);
                slot = null;
                Log.w("CameraCuePlayer", "PCM start failed; using MediaPlayer", e);
                try {
                    prepareMedia();
                } catch (IOException | RuntimeException failure) {
                    throw new IllegalStateException("camera cue fallback failed", failure);
                }
            }
        }
        media.start();
        started = true;
    }

    private static void check(int status) {
        if (status != AudioTrack.SUCCESS) throw new IllegalStateException("AudioTrack status " + status);
    }

    int getCurrentPosition() {
        if (slot == null) return media.getCurrentPosition();
        return (int) (Integer.toUnsignedLong(slot.track.getPlaybackHeadPosition())
                * 1000 / AsgConstants.CAMERA_PCM_SAMPLE_RATE);
    }

    boolean isPlaying() {
        return slot == null ? media != null && media.isPlaying()
                : slot.track.getPlayState() == AudioTrack.PLAYSTATE_PLAYING;
    }

    void stop() {
        if (slot == null) { if (media != null) media.stop(); }
        else slot.track.stop();
        started = false;
    }

    void release() {
        if (released) return;
        released = true;
        if (slot != null) { pool.recycle(slot, false); slot = null; }
        if (media != null) { media.release(); media = null; }
    }

    /** Accept only the packaged 48 kHz stereo PCM16 format; malformed input falls back. */
    static byte[] decodeStereoPcm(byte[] wav) throws IOException {
        ByteBuffer bytes = ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN);
        if (wav.length < 12 || bytes.getInt(0) != 0x46464952 || bytes.getInt(8) != 0x45564157) {
            throw new IOException("not RIFF/WAVE");
        }
        boolean format = false;
        byte[] pcm = null;
        for (int offset = 12; offset <= wav.length - 8;) {
            int type = bytes.getInt(offset);
            int length = bytes.getInt(offset + 4);
            int start = offset + 8;
            if (length < 0 || length > wav.length - start) throw new IOException("truncated WAV chunk");
            if (type == 0x20746d66) {
                if (length < 16 || bytes.getShort(start) != 1 || bytes.getShort(start + 2) != 2
                        || bytes.getInt(start + 4) != AsgConstants.CAMERA_PCM_SAMPLE_RATE
                        || bytes.getShort(start + 12) != 4 || bytes.getShort(start + 14) != 16) {
                    throw new IOException("unsupported cue PCM format");
                }
                format = true;
            } else if (type == 0x61746164) {
                if (length == 0 || length % 4 != 0) throw new IOException("invalid PCM frames");
                pcm = Arrays.copyOfRange(wav, start, start + length);
            }
            offset = start + length;
            if ((length & 1) != 0) offset++;
        }
        if (!format || pcm == null) throw new IOException("missing WAV format/data");
        return pcm;
    }
}
