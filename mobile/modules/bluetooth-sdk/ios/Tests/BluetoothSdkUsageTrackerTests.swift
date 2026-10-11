@testable import MentraBluetoothSDK
import XCTest

final class BluetoothSdkUsageTrackerTests: XCTestCase {
    private var tracker = BluetoothSdkUsageTracker()

    func testApiPhotoReportsItsRequestShapeLatencyAndOutcome() {
        let ok = tracker.photoSettled(
            size: "medium", mode: "photo", compress: "none", save: true, transferMethod: "auto",
            latencyMs: 812, fileSizeBytes: 204_800, errorCode: nil
        )
        XCTAssertEqual(ok.name, "bluetooth_sdk_photo_taken")
        XCTAssertEqual(ok.properties["trigger"] as? String, "api")
        XCTAssertEqual(ok.properties["success"] as? Bool, true)
        XCTAssertEqual(ok.properties["latency_ms"] as? Int64, 812)
        XCTAssertEqual(ok.properties["photo_size"] as? String, "medium")
        XCTAssertEqual(ok.properties["save_to_gallery"] as? Bool, true)
        XCTAssertEqual(ok.properties["transfer_method"] as? String, "auto")
        XCTAssertEqual(ok.properties["file_size_bytes"] as? Int64, 204_800)
        XCTAssertNil(ok.properties["error_code"])

        let failed = tracker.photoSettled(
            size: "max", mode: "photo", compress: "none", save: false, transferMethod: "ble",
            latencyMs: 30000, fileSizeBytes: nil, errorCode: "request_timeout"
        )
        XCTAssertEqual(failed.properties["success"] as? Bool, false)
        XCTAssertEqual(failed.properties["error_code"] as? String, "request_timeout")
        XCTAssertNil(failed.properties["file_size_bytes"])
    }

    func testFailedButtonPhotoIsReportedAsButtonTrigger() {
        let event = tracker.buttonPhotoFailed(errorCode: "CAMERA_BUSY")
        XCTAssertEqual(event.properties["trigger"] as? String, "button")
        XCTAssertEqual(event.properties["success"] as? Bool, false)
        XCTAssertEqual(event.properties["error_code"] as? String, "CAMERA_BUSY")
        XCTAssertEqual(tracker.buttonPhotoFailed(errorCode: nil).properties["error_code"] as? String, "photo_request_failed")
    }

    func testApiRecordingReportsLengthParametersAndAppStopOnce() throws {
        tracker.videoRequested(requestId: "rec-1", width: 1920, height: 1080, fps: 30, save: true, maxDurationMinutes: 0)
        XCTAssertNil(tracker.videoStatus(requestId: "rec-1", status: "recording_started", success: true, nowMs: 1000))
        // A duplicate start does not move the start time.
        XCTAssertNil(tracker.videoStatus(requestId: "rec-1", status: "recording_started", success: true, nowMs: 2000))
        tracker.videoStopRequested(requestId: "rec-1")

        let stopped = try XCTUnwrap(tracker.videoStatus(requestId: "rec-1", status: "recording_stopped", success: true, nowMs: 61000))
        XCTAssertEqual(stopped.name, "bluetooth_sdk_video_recorded")
        XCTAssertEqual(stopped.properties["trigger"] as? String, "api")
        XCTAssertEqual(stopped.properties["success"] as? Bool, true)
        XCTAssertEqual(stopped.properties["duration_ms"] as? Int64, 60000)
        XCTAssertEqual(stopped.properties["width"] as? Int, 1920)
        XCTAssertEqual(stopped.properties["fps"] as? Int, 30)
        XCTAssertEqual(stopped.properties["save_to_gallery"] as? Bool, true)
        XCTAssertEqual(stopped.properties["stopped_by_app"] as? Bool, true)
        XCTAssertNil(stopped.properties["max_duration_minutes"])

        XCTAssertNil(tracker.videoStatus(requestId: "rec-1", status: "recording_stopped", success: true, nowMs: 62000))
    }

    func testButtonRecordingIsReportedWithButtonTriggerAndNoAppStop() throws {
        let id = "local_video_1728000000_ab12"
        _ = tracker.videoStatus(requestId: id, status: "recording_started", success: true, nowMs: 0)
        let stopped = try XCTUnwrap(tracker.videoStatus(requestId: id, status: "recording_stopped", success: true, nowMs: 5000))
        XCTAssertEqual(stopped.properties["trigger"] as? String, "button")
        XCTAssertEqual(stopped.properties["duration_ms"] as? Int64, 5000)
        XCTAssertEqual(stopped.properties["stopped_by_app"] as? Bool, false)
    }

    func testRecordingFailureIsReportedButNotRecordingIsNotARecording() throws {
        tracker.videoRequested(requestId: "rec-2", width: 0, height: 0, fps: 0, save: false, maxDurationMinutes: 5)
        let failed = try XCTUnwrap(tracker.videoStatus(requestId: "rec-2", status: "battery_low", success: false, nowMs: 0))
        XCTAssertEqual(failed.properties["success"] as? Bool, false)
        XCTAssertEqual(failed.properties["error_code"] as? String, "battery_low")
        XCTAssertEqual(failed.properties["max_duration_minutes"] as? Int, 5)
        XCTAssertNil(failed.properties["duration_ms"])
        XCTAssertNil(failed.properties["width"])

        XCTAssertNil(tracker.videoStatus(requestId: "rec-3", status: "not_recording", success: false, nowMs: 0))
        XCTAssertNil(tracker.videoStatus(requestId: "", status: "recording_stopped", success: true, nowMs: 0))
    }

    func testStreamIsReportedAtStartAndOnceAtItsTerminalStatus() throws {
        let started = tracker.streamStartSettled(
            streamId: "s1",
            streamUrl: "rtmps://live.example.com/app/secret-key",
            width: 1280,
            height: 720,
            fps: 30,
            bitrate: 2_000_000,
            captureAudio: true,
            glassesNetwork: "wifi",
            latencyMs: 3400,
            errorCode: nil,
            nowMs: 10000
        )
        XCTAssertEqual(started.name, "bluetooth_sdk_stream_started")
        XCTAssertEqual(started.properties["success"] as? Bool, true)
        XCTAssertEqual(started.properties["protocol"] as? String, "rtmp")
        XCTAssertEqual(started.properties["glasses_network"] as? String, "wifi")
        XCTAssertFalse(started.properties.values.contains { "\($0)".contains("secret-key") })

        XCTAssertNil(stream("reconnecting", reconnectAttempt: 1, nowMs: 20000))
        XCTAssertNil(stream("reconnected", reconnectAttempt: 2, nowMs: 21000))
        XCTAssertNil(stream("streaming", bitrate: 1_800_000, droppedFrames: 12, nowMs: 30000))
        // Statuses for another stream id do not touch this one.
        XCTAssertNil(tracker.streamStatus(
            streamId: "other", state: "stopped", terminal: true, reconnectAttempt: nil, bitrate: nil, fps: nil,
            droppedFrames: nil, temperatureC: nil, errorDetails: nil, nowMs: 31000
        ))
        tracker.streamStopRequested()

        let ended = try XCTUnwrap(stream("stopped", terminal: true, nowMs: 70000))
        XCTAssertEqual(ended.name, "bluetooth_sdk_stream_ended")
        XCTAssertEqual(ended.properties["protocol"] as? String, "rtmp")
        XCTAssertEqual(ended.properties["duration_ms"] as? Int64, 60000)
        XCTAssertEqual(ended.properties["end_state"] as? String, "stopped")
        XCTAssertEqual(ended.properties["stopped_by_app"] as? Bool, true)
        XCTAssertEqual(ended.properties["reconnect_attempts"] as? Int, 2)
        XCTAssertEqual(ended.properties["bitrate"] as? Int64, 1_800_000)
        XCTAssertEqual(ended.properties["dropped_frames"] as? Int64, 12)

        XCTAssertNil(stream("stopped", terminal: true, nowMs: 71000))
    }

    func testOlderGlassesEndAStreamOnStoppedAndErrorDetailsLoseTheirUrls() throws {
        _ = tracker.streamStartSettled(
            streamId: "s2", streamUrl: "https://whip.example.com/whip/abc", width: nil, height: nil, fps: nil,
            bitrate: nil, captureAudio: false, glassesNetwork: "hotspot", latencyMs: 100, errorCode: nil, nowMs: 0
        )
        XCTAssertNil(tracker.streamStatus(
            streamId: nil, state: "error", terminal: nil, reconnectAttempt: nil, bitrate: nil, fps: nil,
            droppedFrames: nil, temperatureC: nil, errorDetails: nil, nowMs: 1000
        ))
        let ended = try XCTUnwrap(tracker.streamStatus(
            streamId: nil, state: "reconnect_failed", terminal: nil, reconnectAttempt: nil, bitrate: nil, fps: nil,
            droppedFrames: nil, temperatureC: nil, errorDetails: "connect to https://whip.example.com/whip/abc failed",
            nowMs: 9000
        ))
        XCTAssertEqual(ended.properties["protocol"] as? String, "whip")
        XCTAssertEqual(ended.properties["end_state"] as? String, "reconnect_failed")
        XCTAssertEqual(ended.properties["error_code"] as? String, "connect to <url> failed")
        XCTAssertEqual(ended.properties["stopped_by_app"] as? Bool, false)
    }

    func testFailedStreamStartReportsTheErrorAndOpensNoStream() {
        let failed = tracker.streamStartSettled(
            streamId: "s3", streamUrl: "srt://host:9000", width: nil, height: nil, fps: nil, bitrate: nil,
            captureAudio: true, glassesNetwork: "none", latencyMs: 30000, errorCode: "stream_start_failed", nowMs: 0
        )
        XCTAssertEqual(failed.properties["success"] as? Bool, false)
        XCTAssertEqual(failed.properties["error_code"] as? String, "stream_start_failed")
        XCTAssertEqual(failed.properties["protocol"] as? String, "srt")
        XCTAssertNil(tracker.streamStatus(
            streamId: "s3", state: "stopped", terminal: true, reconnectAttempt: nil, bitrate: nil, fps: nil,
            droppedFrames: nil, temperatureC: nil, errorDetails: nil, nowMs: 1000
        ))
    }

    func testStreamProtocolFollowsTheGlassesSchemeMapping() {
        XCTAssertEqual(BluetoothSdkUsageTracker.streamProtocol("rtmp://a"), "rtmp")
        XCTAssertEqual(BluetoothSdkUsageTracker.streamProtocol("RTMPS://a"), "rtmp")
        XCTAssertEqual(BluetoothSdkUsageTracker.streamProtocol("srt://a"), "srt")
        XCTAssertEqual(BluetoothSdkUsageTracker.streamProtocol("http://a"), "whip")
        XCTAssertEqual(BluetoothSdkUsageTracker.streamProtocol("rtmpt://a"), "unknown")
        XCTAssertEqual(BluetoothSdkUsageTracker.streamProtocol("not a url"), "unknown")
    }

    func testMicSessionEndsWhenTheSourceTurnsOffOrChanges() throws {
        XCTAssertNil(tracker.observeMic(currentMic: "", transcribing: false, nowMs: 0))
        XCTAssertNil(tracker.observeMic(currentMic: "glasses", transcribing: false, nowMs: 1000))
        XCTAssertNil(tracker.observeMic(currentMic: "glasses", transcribing: true, nowMs: 2000))

        let switched = try XCTUnwrap(tracker.observeMic(currentMic: "phone", transcribing: false, nowMs: 11000))
        XCTAssertEqual(switched.name, "bluetooth_sdk_mic_session")
        XCTAssertEqual(switched.properties["mic_source"] as? String, "glasses")
        XCTAssertEqual(switched.properties["duration_ms"] as? Int64, 10000)
        XCTAssertEqual(switched.properties["local_transcription"] as? Bool, true)

        let off = try XCTUnwrap(tracker.observeMic(currentMic: "", transcribing: false, nowMs: 14000))
        XCTAssertEqual(off.properties["mic_source"] as? String, "phone")
        XCTAssertEqual(off.properties["duration_ms"] as? Int64, 3000)
        XCTAssertEqual(off.properties["local_transcription"] as? Bool, false)
        XCTAssertNil(tracker.observeMic(currentMic: "", transcribing: false, nowMs: 15000))
    }

    func testWifiAndHotspotSetupReportOutcomeAndLatency() {
        let wifi = tracker.wifiSetupSettled(latencyMs: 4000, errorCode: nil)
        XCTAssertEqual(wifi.properties["success"] as? Bool, true)
        XCTAssertEqual(wifi.properties["latency_ms"] as? Int64, 4000)
        XCTAssertEqual(
            tracker.wifiSetupSettled(latencyMs: 15000, errorCode: "connect_timeout").properties["error_code"] as? String,
            "connect_timeout"
        )
        XCTAssertEqual(tracker.hotspotStartSettled(latencyMs: 2500, errorCode: nil).name, "bluetooth_sdk_hotspot_started")
    }

    func testOtaSessionIsReportedOnceWithItsStartingVersions() throws {
        XCTAssertNil(ota("ota-1", "in_progress", nowMs: 0, fromBuild: "38"))
        XCTAssertNil(ota("ota-1", "step_complete", nowMs: 60000, fromBuild: "39"))
        let done = try XCTUnwrap(ota("ota-1", "complete", nowMs: 300_000, fromBuild: "40"))
        XCTAssertEqual(done.name, "bluetooth_sdk_ota_finished")
        XCTAssertEqual(done.properties["success"] as? Bool, true)
        XCTAssertEqual(done.properties["duration_ms"] as? Int64, 300_000)
        XCTAssertEqual(done.properties["from_build_number"] as? String, "38")
        XCTAssertEqual(done.properties["total_steps"] as? Int, 2)
        XCTAssertNil(done.properties["failed_step_type"])
        XCTAssertNil(ota("ota-1", "complete", nowMs: 301_000, fromBuild: "40"))

        let failed = try XCTUnwrap(ota(
            "ota-2", "failed", nowMs: 0, fromBuild: "40", stepType: "bes",
            error: "download failed: https://ota.example.com/x.bin"
        ))
        XCTAssertEqual(failed.properties["success"] as? Bool, false)
        XCTAssertEqual(failed.properties["failed_step_type"] as? String, "bes")
        XCTAssertEqual(failed.properties["error_message"] as? String, "download failed: <url>")
        XCTAssertNil(failed.properties["duration_ms"])
    }

    func testRequestTimeoutsAreCappedPerTracker() throws {
        var capped = BluetoothSdkUsageTracker(maxRequestTimeouts: 2)
        let first = try XCTUnwrap(capped.requestTimedOut(operation: "photo request"))
        XCTAssertEqual(first.name, "bluetooth_sdk_request_failed")
        XCTAssertEqual(first.properties["operation"] as? String, "photo request")
        XCTAssertEqual(first.properties["error_code"] as? String, "request_timeout")
        XCTAssertNotNil(capped.requestTimedOut(operation: "start stream"))
        XCTAssertNil(capped.requestTimedOut(operation: "start stream"))
    }

    func testButtonPressesCarryTheGalleryMode() {
        let event = tracker.buttonPressed(buttonId: "camera", pressType: "long", galleryModeEnabled: true)
        XCTAssertEqual(event.name, "bluetooth_sdk_button_pressed")
        XCTAssertEqual(event.properties["button_id"] as? String, "camera")
        XCTAssertEqual(event.properties["press_type"] as? String, "long")
        XCTAssertEqual(event.properties["gallery_mode_enabled"] as? Bool, true)
    }

    func testDetailsAreSanitizedAndCapped() {
        XCTAssertNil(BluetoothSdkUsageTracker.sanitizedDetail("   "))
        XCTAssertEqual(BluetoothSdkUsageTracker.sanitizedDetail(String(repeating: "x", count: 500))?.count, 200)
    }

    private func stream(
        _ state: String,
        terminal: Bool? = nil,
        reconnectAttempt: Int? = nil,
        bitrate: Int64? = nil,
        droppedFrames: Int64? = nil,
        nowMs: Int64
    ) -> AnalyticsEvent? {
        tracker.streamStatus(
            streamId: "s1", state: state, terminal: terminal, reconnectAttempt: reconnectAttempt, bitrate: bitrate,
            fps: nil, droppedFrames: droppedFrames, temperatureC: nil, errorDetails: nil, nowMs: nowMs
        )
    }

    private func ota(
        _ sessionId: String,
        _ status: String,
        nowMs: Int64,
        fromBuild: String,
        stepType: String = "apk",
        error: String? = nil
    ) -> AnalyticsEvent? {
        tracker.otaStatus(
            sessionId: sessionId, status: status, stepType: stepType, totalSteps: 2, errorMessage: error,
            fromBuildNumber: fromBuild, fromBesFirmwareVersion: "", fromMtkFirmwareVersion: "", nowMs: nowMs
        )
    }
}
