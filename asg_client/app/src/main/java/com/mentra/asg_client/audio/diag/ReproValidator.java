package com.mentra.asg_client.audio.diag;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Structural rules for a trial. The host generator enforces the same rules before writing a
 * sequence; this copy guards the device against hand-edited or stale files.
 */
public final class ReproValidator {

    /** Capture sources allowed in Milestone 1 supported trials. */
    public static final Set<String> SUPPORTED_CAPTURE_SOURCES =
            Set.of("MIC", "VOICE_COMMUNICATION");
    /** Additional sources allowed only in fault-injection trials. */
    public static final Set<String> FAULT_CAPTURE_SOURCES =
            Set.of("DEFAULT", "CAMCORDER", "VOICE_RECOGNITION");
    public static final Set<String> WAIT_STATES = Set.of("bridge_closed", "af_standby");

    private ReproValidator() {}

    public static List<String> validate(ReproTrial trial) {
        List<String> errors = new ArrayList<>();
        if (trial.id == null || trial.id.isEmpty()) errors.add("trial id is empty");
        if (trial.ops.isEmpty()) errors.add(trial.id + ": no operations");
        boolean faultInjection = ReproTrial.CLASS_FAULT_INJECTION.equals(trial.trialClass);
        if (!faultInjection && !ReproTrial.CLASS_SUPPORTED.equals(trial.trialClass)) {
            errors.add(trial.id + ": unknown class " + trial.trialClass);
        }

        Map<String, ReproOp> byId = new HashMap<>();
        for (ReproOp op : trial.ops) {
            if (op.id == null || op.id.isEmpty() || op.id.contains(".")
                    || ReproOp.TRIAL_PRODUCER.equals(op.id)) {
                errors.add(trial.id + ": invalid op id '" + op.id + "'");
                continue;
            }
            if (byId.put(op.id, op) != null) errors.add(trial.id + ": duplicate op id " + op.id);
        }

        int ends = 0;
        int captures = 0;
        for (ReproOp op : trial.ops) {
            String where = trial.id + "/" + op.id + ": ";
            if (op.delayMs < 0) errors.add(where + "negative delay");
            if (op.timeoutMs < 0) errors.add(where + "negative timeout");
            String producer = op.anchorProducer();
            String event = op.anchorEvent();
            if (producer.isEmpty() || event.isEmpty()) {
                errors.add(where + "anchor must be <producer>.<event>, got '" + op.anchor + "'");
            } else if (ReproOp.TRIAL_PRODUCER.equals(producer)) {
                if (!ReproOp.TRIAL_START.equals(op.anchor)) {
                    errors.add(where + "only trial.start is a trial anchor");
                }
            } else if (producer.equals(op.id)) {
                errors.add(where + "anchored on itself");
            } else if (!byId.containsKey(producer)) {
                errors.add(where + "anchor producer " + producer + " is not an op in this trial");
            }
            switch (op.type) {
                case END:
                    ends++;
                    break;
                case CAPTURE_START:
                    captures++;
                    validateCapture(op, faultInjection, where, errors);
                    break;
                case CAPTURE_STOP:
                    validateCaptureRef(op, byId, where, errors);
                    break;
                case WAIT_STATE:
                    if (!WAIT_STATES.contains(op.stringParam("state", ""))) {
                        errors.add(where + "unknown wait state " + op.stringParam("state", ""));
                    }
                    break;
                case CUE:
                    if (op.stringParam("asset", "").isEmpty()) errors.add(where + "cue without asset");
                    break;
                case STOP_PLAYBACK:
                    if (!faultInjection) errors.add(where + "stop_playback is cleanup-only");
                    break;
                default:
                    break;
            }
        }
        if (ends != 1) errors.add(trial.id + ": expected exactly one end op, found " + ends);
        if (!faultInjection && captures > 1) {
            errors.add(trial.id + ": supported trials allow at most one capture");
        }
        validateAcyclic(trial, byId, errors);

        for (ReproOp op : trial.cleanup) {
            String where = trial.id + "/cleanup " + op.id + ": ";
            if (op.type != ReproOp.Type.CAPTURE_STOP && op.type != ReproOp.Type.STOP_PLAYBACK) {
                errors.add(where + "cleanup allows only capture_stop and stop_playback");
            }
            if (!op.anchor.isEmpty()) errors.add(where + "cleanup ops run immediately; no anchor");
            if (op.type == ReproOp.Type.CAPTURE_STOP) validateCaptureRef(op, byId, where, errors);
        }
        return errors;
    }

    private static void validateCapture(
            ReproOp op, boolean faultInjection, String where, List<String> errors) {
        String source = op.stringParam("source", "");
        boolean allowed =
                SUPPORTED_CAPTURE_SOURCES.contains(source)
                        || (faultInjection && FAULT_CAPTURE_SOURCES.contains(source));
        if (!allowed) errors.add(where + "capture source not allowed: " + source);
        long rate = op.longParam("rate", 48000);
        if (rate < 8000 || rate > 48000) errors.add(where + "capture rate out of range: " + rate);
        long channels = op.longParam("ch", 1);
        if (channels != 1 && channels != 2) errors.add(where + "capture ch must be 1 or 2");
    }

    private static void validateCaptureRef(
            ReproOp op, Map<String, ReproOp> byId, String where, List<String> errors) {
        ReproOp target = byId.get(op.stringParam("capture", ""));
        if (target == null || target.type != ReproOp.Type.CAPTURE_START) {
            errors.add(where + "capture must name a capture_start op");
        }
    }

    private static void validateAcyclic(
            ReproTrial trial, Map<String, ReproOp> byId, List<String> errors) {
        for (ReproOp start : trial.ops) {
            Set<String> seen = new HashSet<>();
            ReproOp cursor = start;
            while (cursor != null) {
                if (!seen.add(cursor.id)) {
                    errors.add(trial.id + ": anchor cycle through " + start.id);
                    break;
                }
                cursor = byId.get(cursor.anchorProducer());
            }
        }
    }
}
