package com.mentra.asg_client.audio.diag;

import android.util.Log;
import java.io.BufferedWriter;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Append-only JSONL record of a run ({@code events.jsonl}). Writes happen on a dedicated thread so
 * file I/O never delays the scheduler loop or the audio path. A small set of lines is mirrored to
 * logcat under {@link #TAG} so the host runner can follow trial boundaries and waits live.
 */
final class ReproEventLog {

    static final String TAG = "AudioRepro";
    /** Prefix of logcat lines the host parses; keep in sync with tools/audio-repro. */
    static final String LOGCAT_PREFIX = "AUDIO_REPRO ";

    private final ExecutorService writer =
            Executors.newSingleThreadExecutor(r -> new Thread(r, "audio-repro-log"));
    private final String runId;
    private Writer out;

    ReproEventLog(File file, String runId) throws IOException {
        this.runId = runId;
        File parent = file.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
            throw new IOException("cannot create " + parent);
        }
        out =
                new BufferedWriter(
                        new OutputStreamWriter(new FileOutputStream(file, true), StandardCharsets.UTF_8));
    }

    void write(String kind, String trialId, long monoNs, Object... kv) {
        JSONObject line = new JSONObject();
        try {
            line.put("k", kind);
            line.put("run", runId);
            if (trialId != null) line.put("trial", trialId);
            line.put("ns", monoNs);
            for (int i = 0; i + 1 < kv.length; i += 2) {
                Object value = kv[i + 1];
                if (value instanceof Map) value = new JSONObject((Map<?, ?>) value);
                line.put(String.valueOf(kv[i]), value == null ? JSONObject.NULL : value);
            }
        } catch (JSONException e) {
            Log.w(TAG, "unserializable log line " + kind, e);
            return;
        }
        String text = line.toString();
        // Capture teardown can report events after close; those lines are intentionally dropped.
        if (writer.isShutdown()) return;
        try {
            writer.execute(() -> {
                try {
                    if (out != null) {
                        out.write(text);
                        out.write('\n');
                    }
                } catch (IOException e) {
                    Log.e(TAG, "events.jsonl write failed", e);
                }
            });
        } catch (RejectedExecutionException ignored) {
            // Closed between the check and the submit.
        }
    }

    /** Mirror a host-visible line to logcat, e.g. {@code trial_start trial=t0001 ns=...}. */
    void logcat(String text) {
        Log.i(TAG, LOGCAT_PREFIX + "run=" + runId + " " + text);
    }

    void flush() {
        if (writer.isShutdown()) return;
        writer.execute(() -> {
            try {
                if (out != null) out.flush();
            } catch (IOException e) {
                Log.e(TAG, "events.jsonl flush failed", e);
            }
        });
    }

    void close() {
        writer.execute(() -> {
            try {
                if (out != null) out.close();
            } catch (IOException e) {
                Log.e(TAG, "events.jsonl close failed", e);
            }
            out = null;
        });
        writer.shutdown();
        try {
            writer.awaitTermination(5, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
