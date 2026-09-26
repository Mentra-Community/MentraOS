package com.mentra.asg_client.audio.diag;

import android.annotation.SuppressLint;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.AudioTimestamp;
import android.media.MediaRecorder;
import com.mentra.asg_client.AsgConstants;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Real {@link AudioRecord} capture for the harness, reporting measured activity rather than API
 * call order: {@code created}, {@code start_returned}, {@code first_frames} (first read that
 * returned data), {@code stop_returned}, and {@code released}. HAL-derived
 * {@link AudioRecord#getTimestamp} samples are logged separately and labeled as such; they are not
 * an independent clock measurement.
 */
final class CaptureDriver {

    interface Events {
        /** A once-per-capture event, delivered to the scheduler as {@code <captureId>.<name>}. */
        void event(String captureId, String name, long monoNs, Map<String, Object> fields);

        /** A repeated sample, logged only. */
        void sample(String captureId, String kind, long monoNs, Map<String, Object> fields);
    }

    private final Events events;
    private final Map<String, Capture> active = new ConcurrentHashMap<>();

    CaptureDriver(Events events) {
        this.events = events;
    }

    int activeCount() {
        return active.size();
    }

    static int sourceFor(String name) {
        switch (name) {
            case "MIC":
                return MediaRecorder.AudioSource.MIC;
            case "VOICE_COMMUNICATION":
                return MediaRecorder.AudioSource.VOICE_COMMUNICATION;
            case "DEFAULT":
                return MediaRecorder.AudioSource.DEFAULT;
            case "CAMCORDER":
                return MediaRecorder.AudioSource.CAMCORDER;
            case "VOICE_RECOGNITION":
                return MediaRecorder.AudioSource.VOICE_RECOGNITION;
            default:
                throw new IllegalArgumentException("unsupported capture source " + name);
        }
    }

    /** Runs on the capture thread. */
    @SuppressLint("MissingPermission")
    void start(String captureId, String sourceName, int rate, int channels, File pcmFile)
            throws IOException {
        if (active.containsKey(captureId)) throw new IllegalStateException(captureId + " already active");
        int channelMask =
                channels == 2 ? AudioFormat.CHANNEL_IN_STEREO : AudioFormat.CHANNEL_IN_MONO;
        int minBuffer =
                AudioRecord.getMinBufferSize(rate, channelMask, AudioFormat.ENCODING_PCM_16BIT);
        if (minBuffer <= 0) throw new IllegalStateException("getMinBufferSize=" + minBuffer);
        int frameBytes = 2 * channels;
        int bufferBytes = Math.max(minBuffer * 2, rate / 10 * frameBytes);
        AudioRecord record =
                new AudioRecord(
                        sourceFor(sourceName),
                        rate,
                        channelMask,
                        AudioFormat.ENCODING_PCM_16BIT,
                        bufferBytes);
        if (record.getState() != AudioRecord.STATE_INITIALIZED) {
            record.release();
            throw new IllegalStateException("AudioRecord not initialized for " + sourceName);
        }
        Capture capture = new Capture(captureId, record, frameBytes, rate, pcmFile);
        active.put(captureId, capture);
        events.event(
                captureId,
                "created",
                System.nanoTime(),
                fields(
                        "source", sourceName,
                        "rate", rate,
                        "ch", channels,
                        "min_buffer", minBuffer,
                        "buffer", bufferBytes,
                        "session", record.getAudioSessionId()));
        try {
            record.startRecording();
        } catch (IllegalStateException e) {
            active.remove(captureId);
            record.release();
            throw e;
        }
        events.event(
                captureId,
                "start_returned",
                System.nanoTime(),
                fields("recording_state", record.getRecordingState()));
        capture.reader = new Thread(capture::readLoop, "audio-repro-read-" + captureId);
        capture.reader.start();
    }

    /** Runs on the capture thread; stopping an unknown or finished capture is a no-op. */
    boolean stop(String captureId) {
        Capture capture = active.remove(captureId);
        if (capture == null) return false;
        capture.running = false;
        try {
            capture.record.stop();
        } catch (IllegalStateException ignored) {
            // Already stopped by an error path; release below still runs.
        }
        events.event(captureId, "stop_returned", System.nanoTime(), fields());
        try {
            capture.reader.join(1_000L);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        capture.record.release();
        events.event(
                captureId,
                "released",
                System.nanoTime(),
                fields(
                        "frames", capture.frames,
                        "reads", capture.reads,
                        "read_errors", capture.readErrors));
        return true;
    }

    void stopAll() {
        for (String captureId : active.keySet().toArray(new String[0])) stop(captureId);
    }

    private static Map<String, Object> fields(Object... kv) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i + 1 < kv.length; i += 2) map.put((String) kv[i], kv[i + 1]);
        return map;
    }

    private final class Capture {
        final String id;
        final AudioRecord record;
        final int frameBytes;
        final int rate;
        final File pcmFile;
        volatile boolean running = true;
        Thread reader;
        long frames;
        long reads;
        long readErrors;

        Capture(String id, AudioRecord record, int frameBytes, int rate, File pcmFile) {
            this.id = id;
            this.record = record;
            this.frameBytes = frameBytes;
            this.rate = rate;
            this.pcmFile = pcmFile;
        }

        void readLoop() {
            byte[] buffer = new byte[Math.max(frameBytes * rate / 50, 1024)];
            AudioTimestamp timestamp = new AudioTimestamp();
            long nextSampleNs = 0L;
            long sampleIntervalNs = AsgConstants.AUDIO_REPRO_CAPTURE_TS_INTERVAL_MS * 1_000_000L;
            boolean first = true;
            try (OutputStream out = pcmFile == null ? null
                    : new BufferedOutputStream(new FileOutputStream(pcmFile))) {
                while (running) {
                    int read = record.read(buffer, 0, buffer.length);
                    long now = System.nanoTime();
                    if (read < 0) {
                        readErrors++;
                        events.event(id, "read_error", now, fields("code", read));
                        return;
                    }
                    if (read == 0) continue;
                    reads++;
                    frames += read / frameBytes;
                    if (out != null) out.write(buffer, 0, read);
                    if (first) {
                        first = false;
                        events.event(id, "first_frames", now, fields("bytes", read, "frames", read / frameBytes));
                    }
                    if (now >= nextSampleNs) {
                        nextSampleNs = now + sampleIntervalNs;
                        int status = record.getTimestamp(timestamp, AudioTimestamp.TIMEBASE_MONOTONIC);
                        events.sample(
                                id,
                                "capture_ts",
                                now,
                                fields(
                                        "hal_derived", true,
                                        "status", status,
                                        "frame_position", timestamp.framePosition,
                                        "ts_ns", timestamp.nanoTime,
                                        "frames_read", frames));
                    }
                }
            } catch (IOException e) {
                events.event(id, "pcm_write_error", System.nanoTime(), fields("error", e.getMessage()));
            }
        }
    }
}
