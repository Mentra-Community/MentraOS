package com.mentra.asg_client.audio.diag;

import com.mentra.asg_client.AsgConstants;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * A concrete, replayable harness sequence ({@code mentra.audio-repro.sequence/1}). Sequences are
 * generated on the host from a matrix and a seed; nothing on the device is randomized, so replaying
 * the same file reproduces the same requests.
 */
public final class ReproSequence {

    public static final String SCHEMA = "mentra.audio-repro.sequence/1";
    private static final Set<String> OP_RESERVED_KEYS = Set.of("id", "op", "at", "timeout_ms");

    public final String runId;
    public final long seed;
    public final String generatorJson;
    public final long anchorTimeoutMs;
    public final long lateToleranceMs;
    public final long maxTrialMs;
    public final long interTrialMs;
    public final List<ReproTrial> trials;

    private ReproSequence(
            String runId,
            long seed,
            String generatorJson,
            long anchorTimeoutMs,
            long lateToleranceMs,
            long maxTrialMs,
            long interTrialMs,
            List<ReproTrial> trials) {
        this.runId = runId;
        this.seed = seed;
        this.generatorJson = generatorJson;
        this.anchorTimeoutMs = anchorTimeoutMs;
        this.lateToleranceMs = lateToleranceMs;
        this.maxTrialMs = maxTrialMs;
        this.interTrialMs = interTrialMs;
        this.trials = Collections.unmodifiableList(trials);
    }

    /** Parse and validate; throws {@link IllegalArgumentException} listing every problem. */
    public static ReproSequence parse(JSONObject json) {
        List<String> errors = new ArrayList<>();
        String schema = json.optString("schema", "");
        if (!SCHEMA.equals(schema)) errors.add("unsupported schema '" + schema + "'");
        String runId = json.optString("run_id", "");
        if (!runId.matches("[A-Za-z0-9._-]{1,64}")) {
            errors.add("run_id must be 1-64 characters of [A-Za-z0-9._-]");
        }
        JSONObject defaults = json.optJSONObject("defaults");
        if (defaults == null) defaults = new JSONObject();
        JSONObject generator = json.optJSONObject("generator");

        List<ReproTrial> trials = new ArrayList<>();
        JSONArray trialArray = json.optJSONArray("trials");
        if (trialArray == null || trialArray.length() == 0) errors.add("no trials");
        for (int i = 0; trialArray != null && i < trialArray.length(); i++) {
            try {
                ReproTrial trial = parseTrial(trialArray.getJSONObject(i));
                errors.addAll(ReproValidator.validate(trial));
                trials.add(trial);
            } catch (JSONException | IllegalArgumentException e) {
                errors.add("trial[" + i + "]: " + e.getMessage());
            }
        }
        if (!errors.isEmpty()) throw new IllegalArgumentException(String.join("; ", errors));
        return new ReproSequence(
                runId,
                json.optLong("seed", 0L),
                generator == null ? "{}" : generator.toString(),
                defaults.optLong("anchor_timeout_ms", AsgConstants.AUDIO_REPRO_ANCHOR_TIMEOUT_MS),
                defaults.optLong("late_tolerance_ms", AsgConstants.AUDIO_REPRO_LATE_TOLERANCE_MS),
                defaults.optLong("max_trial_ms", AsgConstants.AUDIO_REPRO_MAX_TRIAL_MS),
                defaults.optLong("inter_trial_ms", AsgConstants.AUDIO_REPRO_INTER_TRIAL_MS),
                trials);
    }

    private static ReproTrial parseTrial(JSONObject json) throws JSONException {
        List<ReproOp> ops = parseOps(json.getJSONArray("ops"), false);
        JSONArray cleanupArray = json.optJSONArray("cleanup");
        List<ReproOp> cleanup =
                cleanupArray == null ? Collections.emptyList() : parseOps(cleanupArray, true);
        Map<String, String> expect = new LinkedHashMap<>();
        JSONObject expectJson = json.optJSONObject("expect");
        if (expectJson != null) {
            for (Iterator<String> keys = expectJson.keys(); keys.hasNext(); ) {
                String key = keys.next();
                expect.put(key, expectJson.optString(key));
            }
        }
        return new ReproTrial(
                json.getString("id"),
                json.optString("block", ""),
                json.optString("cell", ""),
                json.optString("class", ReproTrial.CLASS_SUPPORTED),
                json.optString("reset", ""),
                ops,
                cleanup,
                json.optLong("pre_delay_ms", -1L),
                json.optLong("max_ms", 0L),
                expect);
    }

    private static List<ReproOp> parseOps(JSONArray array, boolean cleanup) throws JSONException {
        List<ReproOp> ops = new ArrayList<>();
        for (int i = 0; i < array.length(); i++) {
            JSONObject json = array.getJSONObject(i);
            String id = json.optString("id", cleanup ? "cleanup" + i : "");
            ReproOp.Type type = ReproOp.Type.fromWire(json.getString("op"));
            String anchor = "";
            long delayMs = 0L;
            JSONObject at = json.optJSONObject("at");
            if (at != null) {
                anchor = at.optString("anchor", "");
                delayMs = at.optLong("delay_ms", 0L);
            }
            Map<String, Object> params = new LinkedHashMap<>();
            for (Iterator<String> keys = json.keys(); keys.hasNext(); ) {
                String key = keys.next();
                if (OP_RESERVED_KEYS.contains(key)) continue;
                Object value = json.get(key);
                if (value instanceof JSONObject || value instanceof JSONArray) {
                    params.put(key, value.toString());
                } else if (value != JSONObject.NULL) {
                    params.put(key, value);
                }
            }
            if (type == ReproOp.Type.CUE && !params.containsKey("asset")) {
                params.put("asset", "recording_start.wav");
            }
            ops.add(new ReproOp(id, type, anchor, delayMs, json.optLong("timeout_ms", 0L), params));
        }
        return ops;
    }
}
