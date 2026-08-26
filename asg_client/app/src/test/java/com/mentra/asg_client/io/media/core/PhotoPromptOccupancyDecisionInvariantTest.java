package com.mentra.asg_client.io.media.core;

import static org.assertj.core.api.Assertions.assertThat;

import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.LinkStateMachine.PhonePresence;
import com.mentra.asg_client.service.core.handlers.subscribers.ButtonCaptureDecision;
import org.junit.Test;

/**
 * Pins the occupancy predicate to the local-capture decision matrix. Occupancy is a function of the
 * three busy flags only; {@link ButtonCaptureDecision.Action#SKIP_LOCAL} short-circuits on gallery
 * and presence before those flags are consulted, so that row is excluded from the biconditional.
 */
public class PhotoPromptOccupancyDecisionInvariantTest {

    @Test
    public void occupancyMatchesDropBusyOrStopRecording_acrossPressGalleryAndPresence() {
        int cases = 0;
        for (boolean isLongPress : new boolean[] {false, true}) {
            for (boolean galleryMode : new boolean[] {false, true}) {
                for (PhonePresence presence : PhonePresence.values()) {
                    for (boolean isRecordingVideo : new boolean[] {false, true}) {
                        for (boolean isCaptureInFlight : new boolean[] {false, true}) {
                            for (boolean isPhotoJobInFlight : new boolean[] {false, true}) {
                                cases++;
                                boolean suppressed =
                                        PhotoPromptOccupancy.suppressed(
                                                isCaptureInFlight,
                                                isPhotoJobInFlight,
                                                isRecordingVideo);
                                ButtonCaptureDecision.Action action =
                                        ButtonCaptureDecision.decide(
                                                isLongPress,
                                                galleryMode,
                                                presence,
                                                isRecordingVideo,
                                                isCaptureInFlight,
                                                isPhotoJobInFlight);
                                if (action == ButtonCaptureDecision.Action.SKIP_LOCAL) {
                                    // Gallery/presence wins before busy flags; occupancy is
                                    // press-agnostic and may still be true on this row.
                                    continue;
                                }
                                assertThat(suppressed)
                                        .as(
                                                "occupancy iff DROP_BUSY/STOP_RECORDING"
                                                        + " long=%s gallery=%s presence=%s"
                                                        + " rec=%s cap=%s job=%s action=%s",
                                                isLongPress,
                                                galleryMode,
                                                presence,
                                                isRecordingVideo,
                                                isCaptureInFlight,
                                                isPhotoJobInFlight,
                                                action)
                                        .isEqualTo(
                                                action == ButtonCaptureDecision.Action.DROP_BUSY
                                                        || action
                                                                == ButtonCaptureDecision.Action
                                                                        .STOP_RECORDING);
                            }
                        }
                    }
                }
            }
        }
        assertThat(cases).isEqualTo(96);
    }
}
