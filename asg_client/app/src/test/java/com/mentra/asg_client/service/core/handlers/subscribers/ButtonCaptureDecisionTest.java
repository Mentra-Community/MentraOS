package com.mentra.asg_client.service.core.handlers.subscribers;

import static org.assertj.core.api.Assertions.assertThat;

import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.LinkStateMachine.PhonePresence;
import org.junit.Test;

public class ButtonCaptureDecisionTest {

    private static final PhonePresence[] PRESENCES = PhonePresence.values();

    @Test
    public void exhaustiveMatrix_matchesSignedOffBehavior() {
        int cases = 0;
        for (boolean isLongPress : new boolean[] {false, true}) {
            for (boolean galleryMode : new boolean[] {false, true}) {
                for (PhonePresence presence : PRESENCES) {
                    for (boolean isRecordingVideo : new boolean[] {false, true}) {
                        for (boolean isCaptureInFlight : new boolean[] {false, true}) {
                            for (boolean isPhotoJobInFlight : new boolean[] {false, true}) {
                                ButtonCaptureDecision.Action action =
                                        ButtonCaptureDecision.decide(
                                                isLongPress,
                                                galleryMode,
                                                presence,
                                                isRecordingVideo,
                                                isCaptureInFlight,
                                                isPhotoJobInFlight);
                                cases++;
                                assertInvariants(action, galleryMode, presence, isRecordingVideo);
                                assertExpected(
                                        action,
                                        isLongPress,
                                        galleryMode,
                                        presence,
                                        isRecordingVideo,
                                        isCaptureInFlight,
                                        isPhotoJobInFlight);
                            }
                        }
                    }
                }
            }
        }
        assertThat(cases).isEqualTo(96);
    }

    @Test
    public void namedCase_shortPressIdle_takesPhoto() {
        assertThat(
                        ButtonCaptureDecision.decide(
                                false, true, PhonePresence.UNKNOWN, false, false, false))
                .isEqualTo(ButtonCaptureDecision.Action.TAKE_PHOTO);
    }

    @Test
    public void namedCase_longPressIdle_startsVideo() {
        assertThat(
                        ButtonCaptureDecision.decide(
                                true, true, PhonePresence.UNKNOWN, false, false, false))
                .isEqualTo(ButtonCaptureDecision.Action.START_VIDEO);
    }

    @Test
    public void namedCase_shortPressWhileCaptureInFlight_drops() {
        assertThat(
                        ButtonCaptureDecision.decide(
                                false, true, PhonePresence.UNKNOWN, false, true, false))
                .isEqualTo(ButtonCaptureDecision.Action.DROP_BUSY);
    }

    @Test
    public void namedCase_longPressWhileCaptureInFlight_drops() {
        assertThat(
                        ButtonCaptureDecision.decide(
                                true, true, PhonePresence.UNKNOWN, false, true, false))
                .isEqualTo(ButtonCaptureDecision.Action.DROP_BUSY);
    }

    @Test
    public void namedCase_shortPressWhileRecordingAndBusy_stillStops() {
        assertThat(
                        ButtonCaptureDecision.decide(
                                false, true, PhonePresence.UNKNOWN, true, true, true))
                .isEqualTo(ButtonCaptureDecision.Action.STOP_RECORDING);
    }

    @Test
    public void namedCase_galleryOffPhonePresent_skipsRegardlessOfBusy() {
        assertThat(
                        ButtonCaptureDecision.decide(
                                false, false, PhonePresence.PRESENT, false, true, true))
                .isEqualTo(ButtonCaptureDecision.Action.SKIP_LOCAL);
    }

    @Test
    public void namedCase_sdkUploadTail_blocksButtonPhoto() {
        assertThat(
                        ButtonCaptureDecision.decide(
                                false, true, PhonePresence.UNKNOWN, false, false, true))
                .isEqualTo(ButtonCaptureDecision.Action.DROP_BUSY);
    }

    private static void assertInvariants(
            ButtonCaptureDecision.Action action,
            boolean galleryMode,
            PhonePresence presence,
            boolean isRecordingVideo) {
        if (isRecordingVideo && (galleryMode || presence != PhonePresence.PRESENT)) {
            assertThat(action)
                    .as("recording must remain stoppable")
                    .isEqualTo(ButtonCaptureDecision.Action.STOP_RECORDING);
            assertThat(action).isNotEqualTo(ButtonCaptureDecision.Action.DROP_BUSY);
        }
        if (!galleryMode && presence == PhonePresence.PRESENT) {
            assertThat(action).isEqualTo(ButtonCaptureDecision.Action.SKIP_LOCAL);
        }
    }

    private static void assertExpected(
            ButtonCaptureDecision.Action action,
            boolean isLongPress,
            boolean galleryMode,
            PhonePresence presence,
            boolean isRecordingVideo,
            boolean isCaptureInFlight,
            boolean isPhotoJobInFlight) {
        ButtonCaptureDecision.Action expected;
        if (!galleryMode && presence == PhonePresence.PRESENT) {
            expected = ButtonCaptureDecision.Action.SKIP_LOCAL;
        } else if (isRecordingVideo) {
            expected = ButtonCaptureDecision.Action.STOP_RECORDING;
        } else if (isCaptureInFlight || isPhotoJobInFlight) {
            expected = ButtonCaptureDecision.Action.DROP_BUSY;
        } else {
            expected =
                    isLongPress
                            ? ButtonCaptureDecision.Action.START_VIDEO
                            : ButtonCaptureDecision.Action.TAKE_PHOTO;
        }
        assertThat(action).isEqualTo(expected);
    }
}
