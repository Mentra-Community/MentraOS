package com.mentra.asg_client.service.core.handlers.subscribers;

import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.LinkStateMachine;

/**
 * Pure local-capture decision for a camera-button press. Universal phone forwarding happens before
 * this runs and is not represented here.
 *
 * <p>Ordering is load-bearing: the gallery/presence gate precedes recording, and recording precedes
 * busy, so a press never logs as {@link Action#DROP_BUSY} when it should skip or stop.
 */
public final class ButtonCaptureDecision {

    public enum Action {
        SKIP_LOCAL,
        STOP_RECORDING,
        TAKE_PHOTO,
        START_VIDEO,
        DROP_BUSY
    }

    private ButtonCaptureDecision() {}

    public static Action decide(
            boolean isLongPress,
            boolean galleryMode,
            LinkStateMachine.PhonePresence presence,
            boolean isRecordingVideo,
            boolean isCaptureInFlight,
            boolean isPhotoJobInFlight) {
        boolean phonePresent = presence == LinkStateMachine.PhonePresence.PRESENT;
        if (!galleryMode && phonePresent) {
            return Action.SKIP_LOCAL;
        }
        if (isRecordingVideo) {
            return Action.STOP_RECORDING;
        }
        if (isCaptureInFlight || isPhotoJobInFlight) {
            return Action.DROP_BUSY;
        }
        return isLongPress ? Action.START_VIDEO : Action.TAKE_PHOTO;
    }
}
