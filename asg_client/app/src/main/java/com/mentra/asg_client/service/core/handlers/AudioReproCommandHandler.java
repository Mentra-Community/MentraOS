package com.mentra.asg_client.service.core.handlers;

import android.content.Context;
import android.util.Log;
import com.mentra.asg_client.audio.diag.AudioReproGate;
import com.mentra.asg_client.audio.diag.AudioReproRunner;
import com.mentra.asg_client.audio.diag.ReproSequence;
import com.mentra.asg_client.service.legacy.interfaces.ICommandHandler;
import com.mentra.asg_client.service.system.interfaces.IConfigurationManager;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Audio reproduction harness commands for engineering runs over adb. Every command is refused
 * unless the gate file exists (see {@link AudioReproGate}), so this handler never alters
 * production behavior. Results are reported as {@code AUDIO_REPRO ...} logcat lines under the
 * {@code AudioRepro} tag, which the host runner follows.
 *
 * <ul>
 *   <li>{@code audio_repro_run}: {@code sequence_path} relative to the harness root, or an inline
 *       {@code sequence} object.
 *   <li>{@code audio_repro_signal}: {@code key} such as {@code w0.satisfied}, optional
 *       {@code fields}.
 *   <li>{@code audio_repro_abort}, {@code audio_repro_pause}, {@code audio_repro_resume},
 *       {@code audio_repro_status}.
 * </ul>
 */
public class AudioReproCommandHandler implements ICommandHandler {

    private static final String TAG = "AudioRepro";
    private static final String PREFIX = "AUDIO_REPRO ";

    public static final String COMMAND_RUN = "audio_repro_run";
    public static final String COMMAND_ABORT = "audio_repro_abort";
    public static final String COMMAND_PAUSE = "audio_repro_pause";
    public static final String COMMAND_RESUME = "audio_repro_resume";
    public static final String COMMAND_STATUS = "audio_repro_status";
    public static final String COMMAND_SIGNAL = "audio_repro_signal";

    private final Context context;

    public AudioReproCommandHandler(
            Context context,
            K900CommandHandler k900CommandHandler,
            IConfigurationManager configurationManager) {
        Context application = context.getApplicationContext();
        this.context = application != null ? application : context;
        AudioReproRunner.get(this.context)
                .setBesLogDependencies(k900CommandHandler, configurationManager);
    }

    @Override
    public Set<String> getSupportedCommandTypes() {
        return Set.of(
                COMMAND_RUN,
                COMMAND_ABORT,
                COMMAND_PAUSE,
                COMMAND_RESUME,
                COMMAND_STATUS,
                COMMAND_SIGNAL);
    }

    @Override
    public boolean handleCommand(String commandType, JSONObject data) {
        if (!AudioReproGate.isEnabled(context)) {
            Log.w(TAG, PREFIX + "refused command=" + commandType + " reason=gate_disabled");
            return false;
        }
        AudioReproRunner runner = AudioReproRunner.get(context);
        switch (commandType) {
            case COMMAND_RUN:
                return handleRun(runner, data);
            case COMMAND_ABORT:
                runner.abort();
                return true;
            case COMMAND_PAUSE:
                runner.pause();
                return true;
            case COMMAND_RESUME:
                runner.resume();
                return true;
            case COMMAND_STATUS:
                runner.logStatus();
                return true;
            case COMMAND_SIGNAL:
                return handleSignal(runner, data);
            default:
                Log.e(TAG, "Unsupported command: " + commandType);
                return false;
        }
    }

    private boolean handleRun(AudioReproRunner runner, JSONObject data) {
        JSONObject json;
        try {
            json = readSequenceJson(data);
        } catch (IOException | JSONException | IllegalArgumentException e) {
            Log.e(TAG, PREFIX + "run_rejected reason=unreadable detail=" + e.getMessage());
            return false;
        }
        ReproSequence sequence;
        try {
            sequence = ReproSequence.parse(json);
        } catch (IllegalArgumentException e) {
            Log.e(TAG, PREFIX + "run_rejected reason=invalid detail=" + e.getMessage());
            return false;
        }
        File base = AudioReproGate.baseDir(context);
        boolean started = runner.start(sequence, base);
        Log.i(TAG, PREFIX + "run_accepted run=" + sequence.runId + " started=" + started);
        return started;
    }

    private JSONObject readSequenceJson(JSONObject data) throws IOException, JSONException {
        if (data == null) throw new IllegalArgumentException("missing command data");
        JSONObject inline = data.optJSONObject("sequence");
        if (inline != null) return inline;
        String path = data.optString("sequence_path", "");
        File file = AudioReproGate.resolveInside(context, path);
        if (file == null || !file.isFile()) {
            throw new IllegalArgumentException("sequence_path must name a file inside the harness root");
        }
        return new JSONObject(new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
    }

    private boolean handleSignal(AudioReproRunner runner, JSONObject data) {
        String key = data != null ? data.optString("key", "") : "";
        if (!key.matches("[A-Za-z0-9_-]+\\.[A-Za-z0-9_]+")) {
            Log.w(TAG, PREFIX + "signal_rejected key=" + key);
            return false;
        }
        Map<String, Object> fields = new LinkedHashMap<>();
        JSONObject fieldJson = data.optJSONObject("fields");
        if (fieldJson != null) {
            for (Iterator<String> keys = fieldJson.keys(); keys.hasNext(); ) {
                String name = keys.next();
                fields.put(name, fieldJson.opt(name));
            }
        }
        runner.signal(key, fields);
        return true;
    }
}
