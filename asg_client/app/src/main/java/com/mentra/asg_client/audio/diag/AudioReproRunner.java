package com.mentra.asg_client.audio.diag;

import android.content.Context;
import android.media.AudioManager;
import android.media.AudioPlaybackConfiguration;
import android.media.AudioRecordingConfiguration;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.os.Process;
import android.os.SystemClock;
import android.util.Log;
import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.audio.AudioAssets;
import com.mentra.asg_client.io.hardware.core.HardwareManagerFactory;
import com.mentra.asg_client.io.hardware.interfaces.IHardwareManager;
import com.mentra.asg_client.service.core.handlers.K900CommandHandler;
import com.mentra.asg_client.service.system.interfaces.IConfigurationManager;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Executes a {@link ReproSequence} against the real production cue and capture paths.
 *
 * <p>Threads: a scheduler loop thread owns all run state; cues and BES log pulls run on the main
 * thread like other production callers; captures start and stop on a dedicated capture thread.
 * Production trace events, capture events and host signals are funneled onto the loop, bound to
 * operation IDs by {@link TraceBinder}, and scheduled by {@link ReproScheduler}. Trials run one at a
 * time in file order.
 */
public final class AudioReproRunner {

    private static final String TAG = ReproEventLog.TAG;
    /** Spin at most this long on the destination thread to hit a sub-millisecond target. */
    private static final long SPIN_WINDOW_NS = 2_000_000L;

    private static AudioReproRunner sInstance;

    private final Context context;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private K900CommandHandler k900CommandHandler;
    private IConfigurationManager configurationManager;

    // Run state below is confined to the loop thread once a run starts.
    private HandlerThread loopThread;
    private HandlerThread captureThread;
    private Handler loopHandler;
    private Handler captureHandler;
    private ReproSequence sequence;
    private File runDir;
    private ReproEventLog log;
    private ReproScheduler scheduler;
    private TraceBinder binder;
    private CaptureDriver captures;
    private AudioTraceBus.Sink traceSink;
    private AudioManager.AudioRecordingCallback recordingCallback;
    private AudioManager.AudioPlaybackCallback playbackCallback;
    private int nextTrialIndex;
    private boolean trialActive;
    private boolean paused;
    private boolean aborting;
    private String currentTrialId;
    private Boolean bridgeOpen;
    private final List<String> bridgeClosedWaiters = new ArrayList<>();
    private volatile boolean running;

    private AudioReproRunner(Context context) {
        Context application = context.getApplicationContext();
        this.context = application != null ? application : context;
    }

    public static synchronized AudioReproRunner get(Context context) {
        if (sInstance == null) sInstance = new AudioReproRunner(context);
        return sInstance;
    }

    /** Dependencies for {@code bes_log_pull}; optional for every other operation. */
    public synchronized void setBesLogDependencies(
            K900CommandHandler k900CommandHandler, IConfigurationManager configurationManager) {
        this.k900CommandHandler = k900CommandHandler;
        this.configurationManager = configurationManager;
    }

    public boolean isRunning() {
        return running;
    }

    /** Start a run; returns false (and logs why) when one is already active or setup fails. */
    public synchronized boolean start(ReproSequence sequence, File baseDir) {
        if (running) {
            Log.w(TAG, ReproEventLog.LOGCAT_PREFIX + "run_rejected reason=already_running");
            return false;
        }
        File dir = new File(new File(baseDir, "runs"), sequence.runId);
        try {
            log = new ReproEventLog(new File(dir, "events.jsonl"), sequence.runId);
        } catch (IOException e) {
            Log.e(TAG, ReproEventLog.LOGCAT_PREFIX + "run_rejected reason=log_open_failed", e);
            return false;
        }
        this.sequence = sequence;
        this.runDir = dir;
        running = true;
        nextTrialIndex = 0;
        trialActive = false;
        paused = false;
        aborting = false;
        bridgeOpen = null;
        bridgeClosedWaiters.clear();

        loopThread = new HandlerThread("audio-repro-loop", Process.THREAD_PRIORITY_AUDIO);
        loopThread.start();
        loopHandler = new Handler(loopThread.getLooper());
        captureThread = new HandlerThread("audio-repro-capture", Process.THREAD_PRIORITY_AUDIO);
        captureThread.start();
        captureHandler = new Handler(captureThread.getLooper());

        binder = new TraceBinder(new BinderOutput());
        captures = new CaptureDriver(new CaptureEvents());
        scheduler =
                new ReproScheduler(
                        System::nanoTime,
                        new HandlerLoop(),
                        new Runner(),
                        new SchedulerListener(),
                        sequence.anchorTimeoutMs,
                        sequence.lateToleranceMs,
                        sequence.maxTrialMs);
        loopHandler.post(this::beginRun);
        return true;
    }

    public void abort() {
        Handler handler = loopHandler;
        if (!running || handler == null) return;
        handler.post(() -> {
            if (!running) return;
            aborting = true;
            if (trialActive) {
                scheduler.abort();
            } else {
                finishRun("aborted");
            }
        });
    }

    public void pause() {
        Handler handler = loopHandler;
        if (running && handler != null) handler.post(() -> paused = true);
    }

    public void resume() {
        Handler handler = loopHandler;
        if (!running || handler == null) return;
        handler.post(() -> {
            if (!paused) return;
            paused = false;
            if (!trialActive) startNextTrial();
        });
    }

    /** A host-verified state or other external event, e.g. {@code w0.satisfied}. */
    public void signal(String key, Map<String, Object> fields) {
        Handler handler = loopHandler;
        if (!running || handler == null) return;
        long now = System.nanoTime();
        Map<String, Object> copy = new LinkedHashMap<>(fields);
        copy.put("source", "host");
        handler.post(() -> {
            log.write("signal", currentTrialId, now, "key", key, "f", copy);
            scheduler.event(key, now, copy);
        });
    }

    /** Log a one-line status to logcat for the host. */
    public void logStatus() {
        Handler handler = loopHandler;
        if (!running || handler == null) {
            Log.i(TAG, ReproEventLog.LOGCAT_PREFIX + "status running=false");
            return;
        }
        handler.post(() -> log.logcat(
                "status running=true trial=" + currentTrialId
                        + " next=" + nextTrialIndex + "/" + sequence.trials.size()
                        + " paused=" + paused + " mono_ns=" + System.nanoTime()));
    }

    private void beginRun() {
        long now = System.nanoTime();
        log.write(
                "run_start",
                null,
                now,
                "seed", sequence.seed,
                "generator", sequence.generatorJson,
                "trials", sequence.trials.size(),
                "fingerprint", Build.FINGERPRINT,
                "sdk", Build.VERSION.SDK_INT,
                "device", Build.DEVICE,
                "app_version", appVersion(),
                "elapsed_realtime_ns", SystemClock.elapsedRealtimeNanos(),
                "wall_ms", System.currentTimeMillis());
        log.logcat("run_start trials=" + sequence.trials.size() + " mono_ns=" + now
                + " wall_ms=" + System.currentTimeMillis());
        traceSink = (event, monoNs, threadName, fields) -> {
            Map<String, Object> copy = new LinkedHashMap<>(fields);
            loopHandler.post(() -> onRawTrace(event, monoNs, threadName, copy));
        };
        AudioTraceBus.setSink(traceSink);
        registerAudioCallbacks();
        startNextTrial();
    }

    private void onRawTrace(String event, long monoNs, String threadName, Map<String, Object> fields) {
        log.write("raw", currentTrialId, monoNs, "event", event, "thread", threadName, "f", fields);
        trackBridge(event, fields, monoNs);
        binder.onRaw(event, monoNs, fields);
    }

    private void trackBridge(String event, Map<String, Object> fields, long monoNs) {
        switch (event) {
            case AudioTraceBus.BRIDGE_OPEN_REQ:
                bridgeOpen = true;
                break;
            case AudioTraceBus.BRIDGE_REUSED:
                if (!AudioTraceBus.REUSE_EXTERNAL.equals(fields.get("reason"))) bridgeOpen = true;
                break;
            case AudioTraceBus.BRIDGE_OPEN_FAILED:
            case AudioTraceBus.BRIDGE_CLOSE:
                bridgeOpen = false;
                List<String> waiters = new ArrayList<>(bridgeClosedWaiters);
                bridgeClosedWaiters.clear();
                for (String opId : waiters) satisfy(opId, monoNs, true, "trace:" + event);
                break;
            default:
                break;
        }
    }

    private void satisfy(String opId, long monoNs, boolean verified, String source) {
        Map<String, Object> fields = new LinkedHashMap<>();
        fields.put("verified", verified);
        fields.put("source", source);
        scheduler.event(opId + ".satisfied", monoNs, fields);
    }

    private void waitBridgeClosed(String opId) {
        long now = System.nanoTime();
        if (Boolean.FALSE.equals(bridgeOpen)) {
            satisfy(opId, now, true, "trace:state");
            return;
        }
        bridgeClosedWaiters.add(opId);
        if (bridgeOpen == null) {
            // No bridge event seen since the run started: an earlier cue's grace may still be
            // running, so wait longer than the grace before assuming the bridge is closed.
            loopHandler.postDelayed(() -> {
                if (bridgeOpen == null && bridgeClosedWaiters.remove(opId)) {
                    satisfy(opId, System.nanoTime(), false, "settle_timeout");
                }
            }, AsgConstants.AUDIO_REPRO_BRIDGE_SETTLE_MS);
        }
    }

    private void startNextTrial() {
        if (!running) return;
        if (aborting) {
            finishRun("aborted");
            return;
        }
        if (paused) return;
        if (nextTrialIndex >= sequence.trials.size()) {
            finishRun("completed");
            return;
        }
        ReproTrial trial = sequence.trials.get(nextTrialIndex++);
        long delayMs = trial.preDelayMs >= 0 ? trial.preDelayMs : sequence.interTrialMs;
        trialActive = true;
        loopHandler.postDelayed(() -> {
            if (!running) return;
            if (aborting) {
                trialActive = false;
                finishRun("aborted");
                return;
            }
            if (paused) {
                // A pause during the pre-delay holds this trial; resume starts it again.
                nextTrialIndex--;
                trialActive = false;
                return;
            }
            currentTrialId = trial.id;
            Map<String, Object> expect = new LinkedHashMap<>(trial.expect);
            log.write(
                    "trial_meta",
                    trial.id,
                    System.nanoTime(),
                    "block", trial.block,
                    "cell", trial.cell,
                    "class", trial.trialClass,
                    "reset", trial.reset,
                    "expect", expect,
                    "active_captures", captures.activeCount(),
                    "bridge_open", bridgeOpen == null ? "unknown" : String.valueOf(bridgeOpen));
            if (captures.activeCount() > 0) {
                log.write("anomaly", trial.id, System.nanoTime(),
                        "kind", "captures_active_at_start", "detail", String.valueOf(captures.activeCount()));
            }
            scheduler.startTrial(trial, () -> {
                trialActive = false;
                startNextTrial();
            });
        }, delayMs);
    }

    private void finishRun(String reason) {
        if (!running) return;
        running = false;
        AudioTraceBus.clearSink(traceSink);
        unregisterAudioCallbacks();
        captureHandler.post(captures::stopAll);
        long now = System.nanoTime();
        log.write("run_end", null, now, "reason", reason, "trials_started", nextTrialIndex);
        log.logcat("run_done reason=" + reason + " trials_started=" + nextTrialIndex
                + " dir=" + runDir.getAbsolutePath());
        ReproEventLog finishedLog = log;
        HandlerThread finishedLoop = loopThread;
        HandlerThread finishedCapture = captureThread;
        captureHandler.post(() -> {
            finishedLog.close();
            finishedCapture.quitSafely();
            finishedLoop.quitSafely();
        });
    }

    private void registerAudioCallbacks() {
        AudioManager audioManager = context.getSystemService(AudioManager.class);
        if (audioManager == null) return;
        recordingCallback =
                new AudioManager.AudioRecordingCallback() {
                    @Override
                    public void onRecordingConfigChanged(List<AudioRecordingConfiguration> configs) {
                        log.write("raw", currentTrialId, System.nanoTime(),
                                "event", "recording_configs", "thread", "callback",
                                "f", recordingSummary(configs));
                    }
                };
        playbackCallback =
                new AudioManager.AudioPlaybackCallback() {
                    @Override
                    public void onPlaybackConfigChanged(List<AudioPlaybackConfiguration> configs) {
                        log.write("raw", currentTrialId, System.nanoTime(),
                                "event", "playback_configs", "thread", "callback",
                                "f", playbackSummary(configs));
                    }
                };
        audioManager.registerAudioRecordingCallback(recordingCallback, loopHandler);
        audioManager.registerAudioPlaybackCallback(playbackCallback, loopHandler);
        recordingCallback.onRecordingConfigChanged(audioManager.getActiveRecordingConfigurations());
        playbackCallback.onPlaybackConfigChanged(audioManager.getActivePlaybackConfigurations());
    }

    private void unregisterAudioCallbacks() {
        AudioManager audioManager = context.getSystemService(AudioManager.class);
        if (audioManager == null) return;
        if (recordingCallback != null) audioManager.unregisterAudioRecordingCallback(recordingCallback);
        if (playbackCallback != null) audioManager.unregisterAudioPlaybackCallback(playbackCallback);
        recordingCallback = null;
        playbackCallback = null;
    }

    private static Map<String, Object> recordingSummary(List<AudioRecordingConfiguration> configs) {
        JSONArray array = new JSONArray();
        for (AudioRecordingConfiguration config : configs) {
            JSONObject item = new JSONObject();
            try {
                item.put("source", config.getClientAudioSource());
                item.put("session", config.getClientAudioSessionId());
                item.put("client_rate", config.getClientFormat().getSampleRate());
                item.put("device_rate", config.getFormat().getSampleRate());
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    item.put("silenced", config.isClientSilenced());
                }
            } catch (JSONException ignored) {
                // Every field above is a primitive; JSONException is unreachable here.
            }
            array.put(item);
        }
        Map<String, Object> fields = new LinkedHashMap<>();
        fields.put("count", configs.size());
        fields.put("configs", array);
        return fields;
    }

    private static Map<String, Object> playbackSummary(List<AudioPlaybackConfiguration> configs) {
        JSONArray array = new JSONArray();
        for (AudioPlaybackConfiguration config : configs) {
            JSONObject item = new JSONObject();
            try {
                item.put("usage", config.getAudioAttributes().getUsage());
                item.put("content", config.getAudioAttributes().getContentType());
            } catch (JSONException ignored) {
                // Primitive fields only.
            }
            array.put(item);
        }
        Map<String, Object> fields = new LinkedHashMap<>();
        fields.put("count", configs.size());
        fields.put("configs", array);
        return fields;
    }

    private String appVersion() {
        try {
            return context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "unknown";
        }
    }

    /** Post so the task starts at {@code targetNs} on the handler's thread, as closely as possible. */
    private static void postPrecise(Handler handler, long targetNs, Runnable task) {
        long delayNs = targetNs - System.nanoTime();
        long delayMs = Math.max(0L, delayNs / 1_000_000L - 1L);
        handler.postAtTime(() -> {
            long remaining = targetNs - System.nanoTime();
            while (remaining > 0 && remaining <= SPIN_WINDOW_NS) {
                remaining = targetNs - System.nanoTime();
            }
            task.run();
        }, SystemClock.uptimeMillis() + delayMs);
    }

    private final class HandlerLoop implements ReproScheduler.Loop {
        @Override
        public void execute(Runnable task) {
            loopHandler.post(task);
        }

        @Override
        public void executeAt(long targetNs, Runnable task) {
            long delayMs = Math.max(0L, (targetNs - System.nanoTime()) / 1_000_000L);
            loopHandler.postDelayed(task, delayMs);
        }
    }

    private final class Runner implements ReproScheduler.OpRunner {
        @Override
        public ReproScheduler.Destination destinationFor(ReproOp op) {
            final Handler handler;
            switch (op.type) {
                case CAPTURE_START:
                case CAPTURE_STOP:
                    handler = captureHandler;
                    break;
                case CUE:
                case STOP_PLAYBACK:
                case BES_LOG_PULL:
                    handler = mainHandler;
                    break;
                default:
                    handler = loopHandler;
                    break;
            }
            return (targetNs, task) -> postPrecise(handler, targetNs, task);
        }

        @Override
        public Object run(String trialId, ReproOp op) throws Exception {
            switch (op.type) {
                case CUE:
                    return hardware().playAudioAssetTracked(
                            op.stringParam("asset", AudioAssets.RECORDING_START));
                case STOP_PLAYBACK:
                    hardware().stopAudioPlayback();
                    return null;
                case CAPTURE_START: {
                    File pcm = op.booleanParam("save_pcm", false)
                            ? new File(new File(runDir, "pcm"), trialId + "-" + op.id + ".pcm")
                            : null;
                    if (pcm != null && pcm.getParentFile() != null) pcm.getParentFile().mkdirs();
                    captures.start(
                            op.id,
                            op.stringParam("source", "MIC"),
                            (int) op.longParam("rate", 48000),
                            (int) op.longParam("ch", 1),
                            pcm);
                    return "started";
                }
                case CAPTURE_STOP:
                    return captures.stop(op.stringParam("capture", ""));
                case WAIT_STATE: {
                    String state = op.stringParam("state", "");
                    if ("bridge_closed".equals(state)) {
                        waitBridgeClosed(op.id);
                    } else {
                        log.logcat("await trial=" + trialId + " key=" + op.id + ".satisfied state=" + state
                                + " mono_ns=" + System.nanoTime());
                    }
                    return "waiting";
                }
                case BES_LOG_PULL:
                    return pullBesLogs(trialId, op);
                case MARK:
                    return op.stringParam("label", "");
                case END:
                default:
                    return null;
            }
        }

        @Override
        public void afterRun(String trialId, ReproOp op, Object result) {
            if (op.type == ReproOp.Type.CUE) {
                binder.bindToken(result instanceof Number ? ((Number) result).longValue() : 0L, op.id);
            }
        }
    }

    private IHardwareManager hardware() {
        return HardwareManagerFactory.getInstance(context);
    }

    private Object pullBesLogs(String trialId, ReproOp op) {
        K900CommandHandler handler;
        IConfigurationManager config;
        synchronized (this) {
            handler = k900CommandHandler;
            config = configurationManager;
        }
        if (handler == null || config == null) throw new IllegalStateException("BES log dependencies unavailable");
        File file = new File(new File(runDir, "bes"), trialId + "-" + op.id + ".txt");
        boolean started = handler.requestBesLogsForTrace(context, config, snapshot -> {
            long now = System.nanoTime();
            String text = snapshot == null ? "" : snapshot;
            Map<String, Object> fields = new LinkedHashMap<>();
            fields.put("bytes", text.length());
            fields.put("file", "bes/" + file.getName());
            try {
                File parent = file.getParentFile();
                if (parent != null) parent.mkdirs();
                try (FileOutputStream out = new FileOutputStream(file)) {
                    out.write(text.getBytes(StandardCharsets.UTF_8));
                }
            } catch (IOException e) {
                fields.put("error", e.getMessage());
            }
            scheduler.event(op.id + ".done", now, fields);
        });
        if (!started) throw new IllegalStateException("mh_logs request not started");
        return "requested";
    }

    private final class BinderOutput implements TraceBinder.Output {
        @Override
        public void event(String key, long monoNs, Map<String, Object> fields) {
            scheduler.event(key, monoNs, fields);
        }

        @Override
        public void anomaly(String kind, String detail, long monoNs) {
            log.write("anomaly", currentTrialId, monoNs, "kind", kind, "detail", detail);
        }
    }

    private final class CaptureEvents implements CaptureDriver.Events {
        @Override
        public void event(String captureId, String name, long monoNs, Map<String, Object> fields) {
            scheduler.event(captureId + "." + name, monoNs, fields);
        }

        @Override
        public void sample(String captureId, String kind, long monoNs, Map<String, Object> fields) {
            Map<String, Object> copy = new LinkedHashMap<>(fields);
            copy.put("capture", captureId);
            loopHandler.post(() -> log.write("sample", currentTrialId, monoNs, "kind", kind, "f", copy));
        }
    }

    private final class SchedulerListener implements ReproScheduler.Listener {
        @Override
        public void onTrialStart(String trialId, long startNs) {
            log.write("trial_start", trialId, startNs);
            log.logcat("trial_start trial=" + trialId + " mono_ns=" + startNs);
        }

        @Override
        public void onEvent(String trialId, String key, long monoNs, Map<String, Object> fields) {
            log.write("event", trialId, monoNs, "key", key, "f", fields);
        }

        @Override
        public void onExec(ReproScheduler.ExecRecord r) {
            log.write(
                    "exec",
                    r.trialId,
                    r.beginNs,
                    "op", r.opId,
                    "type", r.type,
                    "cleanup", r.cleanup,
                    "anchor", r.anchorKey,
                    "anchor_ns", r.anchorNs,
                    "target_ns", r.targetNs,
                    "post_ns", r.postNs,
                    "begin_ns", r.beginNs,
                    "end_ns", r.endNs,
                    "late_ns", r.cleanup ? 0L : r.latenessNs(),
                    "late", r.late,
                    "result", r.result,
                    "error", r.error);
        }

        @Override
        public void onAnomaly(String trialId, String kind, String detail, long monoNs) {
            log.write("anomaly", trialId, monoNs, "kind", kind, "detail", detail);
        }

        @Override
        public void onTrialEnd(ReproScheduler.TrialResult result) {
            binder.endTrial();
            Map<String, Object> status = new LinkedHashMap<>(result.opStatus);
            log.write(
                    "trial_end",
                    result.trialId,
                    result.endNs,
                    "outcome", result.outcome,
                    "flags", new JSONArray(result.flags),
                    "start_ns", result.startNs,
                    "op_status", status);
            log.flush();
            log.logcat("trial_end trial=" + result.trialId + " outcome=" + result.outcome
                    + " flags=" + String.join(",", result.flags) + " mono_ns=" + result.endNs);
            currentTrialId = null;
        }
    }
}
