@testable import MentraBluetoothSDK
import XCTest

@MainActor
final class DeviceManagerReconnectTests: XCTestCase {
    private let requests = ["should_send_lc3", "should_send_pcm", "should_send_transcript", "local_stt_fallback_active"]

    func testActualManagerHandoffCleanupDoesNotInvalidateClosedOriginalStatus() {
        withRecordingDevice { manager, _ in
            let original = manager.sgc as! ReconnectRecordingDevice
            original.type = DeviceTypes.NIMO
            let uuid = "00000000-0000-4000-8000-000000000001"
            let model = NimoResourceSession(captureNonce: uuid, pair: NimoResourcePair(name: "Nimo-Test", peripheralUuid: uuid))
            XCTAssertTrue(model.admit(original, instanceId: uuid, name: "Nimo-Test"))
            XCTAssertTrue(model.beginRelease(nonce: uuid, cancel: true, mic: false, canvas: false))
            model.proveNoTransport()
            let verifiedClosed = model.settled(producers: NimoResourceProducers())
            var cleanupCalls = 0, disconnectEffects = 0
            original.onCleanup = {
                cleanupCalls += 1
                // Same original-session guard used by actual Nimo.disconnect.
                if model.shouldRunOrdinaryDisconnect(original, originalClosed: verifiedClosed) { disconnectEffects += 1 }
            }
            manager.initSGC(DeviceTypes.SIMULATED) // Actual manager replacement; no Bluetooth device.
            XCTAssertEqual(cleanupCalls, 1)
            XCTAssertEqual(disconnectEffects, 0)
            XCTAssertTrue(model.errors.isEmpty)
            XCTAssertTrue(model.settled(producers: NimoResourceProducers())) // Fresh status after cleanup.
            XCTAssertTrue(NimoResourceManagerState.allowsReplacement(fixtureEnabled: true, originalClosed: model.settled(producers: NimoResourceProducers())))
            XCTAssertEqual(manager.sgc?.type, DeviceTypes.SIMULATED)
        }
    }

    func testActualQueuedReplacementDoesNotJoinOriginalNimoProducerRoster() {
        withRecordingDevice { manager, store in
            let original = manager.sgc as! ReconnectRecordingDevice
            original.type = DeviceTypes.NIMO
            let uuid = "00000000-0000-4000-8000-000000000001"
            let model = NimoResourceSession(captureNonce: uuid, pair: NimoResourcePair(name: "Nimo-Test", peripheralUuid: uuid))
            XCTAssertTrue(model.admit(original, instanceId: uuid, name: "Nimo-Test"))
            XCTAssertTrue(model.beginRelease(nonce: uuid, cancel: true, mic: false, canvas: false)); model.proveNoTransport()
            let stopped = expectation(description: "Original disposal inside real queued manager handoff")
            original.onDisconnect = {
                XCTAssertFalse(model.shouldRunOrdinaryDisconnect(original, originalClosed: true))
                stopped.fulfill()
            }
            // Same asynchronous connectByName path as G2; simulated replacement
            // avoids any Bluetooth transport in this source regression.
            store.set("bluetooth", "pending_wearable", DeviceTypes.SIMULATED)
            manager.connectByName("Simulated")
            XCTAssertEqual(NimoResourceFixture.shared.pendingManagerEntries, 1)
            XCTAssertEqual(NimoResourceFixture.shared.pendingOriginalManagerEntries, 0)
            wait(for: [stopped], timeout: 1)
            var producers = NimoResourceProducers()
            producers.postedCallbacks = NimoResourceFixture.shared.pendingOriginalManagerEntries
            XCTAssertTrue(model.settled(producers: producers)) // Fresh status during replacement wait.
            XCTAssertTrue(model.errors.isEmpty)
            let completed = expectation(description: "Replacement queued work has actually settled")
            Task { @MainActor in
                let deadline = ProcessInfo.processInfo.systemUptime + 2
                while ProcessInfo.processInfo.systemUptime < deadline {
                    if NimoResourceFixture.shared.pendingManagerEntries == 0,
                       manager.sgc?.type == DeviceTypes.SIMULATED {
                        completed.fulfill()
                        return
                    }
                    try? await Task.sleep(nanoseconds: 5_000_000)
                }
                // Leave the expectation unmet on timeout; elapsed delay alone
                // cannot stand in for the queued manager's actual completion.
            }
            wait(for: [completed], timeout: 2.5)
            XCTAssertEqual(NimoResourceFixture.shared.pendingManagerEntries, 0)
            XCTAssertTrue(model.settled(producers: NimoResourceProducers()))
            XCTAssertEqual(manager.sgc?.type, DeviceTypes.SIMULATED)
        }
    }

    func testDelayedReconnectReplayPreservesNimoDepthEndpoints() {
        for depth in [0, 10] {
            withRecordingDevice { manager, store in
                let device = manager.sgc as! ReconnectRecordingDevice
                device.type = DeviceTypes.NIMO
                store.set("bluetooth", "dashboard_height", 7)
                store.set("bluetooth", "dashboard_depth", depth)
                let replayed = expectation(description: "Delayed NIMO depth \(depth)")
                replayed.assertForOverFulfill = false
                device.onPosition = { replayed.fulfill() }
                manager.handleDeviceReady()
                XCTAssertTrue(device.positions.isEmpty)
                wait(for: [replayed], timeout: 3)
                XCTAssertEqual(device.positions.last?.0, 7)
                XCTAssertEqual(device.positions.last?.1, depth)
            }
        }
    }

    private func withRecordingDevice(_ body: (DeviceManager, DeviceStore) -> Void) {
        let manager = DeviceManager.shared
        let store = DeviceStore.shared
        let saved = ["bluetooth", "glasses"].map { ($0, store.store.getCategory($0)) }
        let previousDevice = manager.sgc
        let previousController = manager.controller
        let previousClock = manager.micWatchdogNow
        manager.micWatchdogNow = { 0 }
        defer {
            store.set("bluetooth", "micEnabled", false)
            manager.updateMicState()
            manager.micWatchdogNow = previousClock
            manager.sgc = previousDevice
            manager.controller = previousController
            for (category, values) in saved {
                for key in store.store.getCategory(category).keys where values[key] == nil {
                    store.store.remove(category, key)
                }
                for (key, value) in values {
                    store.set(category, key, value)
                }
            }
        }
        manager.controller = nil
        manager.sgc = ReconnectRecordingDevice()
        for key in requests {
            store.set("bluetooth", key, false)
        }
        store.set("bluetooth", "micEnabled", false)
        store.set("bluetooth", "micRanking", [MicTypes.GLASSES_CUSTOM])
        store.set("glasses", "micEnabled", false)
        store.set("glasses", "fullyBooted", false)
        body(manager, store)
    }

    func testReconnectRestoresUnchangedAudioRequests() {
        for request in requests {
            withRecordingDevice { manager, store in
                store.apply("bluetooth", request, true)
                XCTAssertEqual(store.get("bluetooth", "micEnabled") as? Bool, true)
                XCTAssertEqual(store.get("glasses", "micEnabled") as? Bool, true)
                for _ in 0 ..< 3 {
                    manager.disconnect()
                    XCTAssertEqual(store.get("bluetooth", request) as? Bool, true)
                    XCTAssertEqual(store.get("bluetooth", "micEnabled") as? Bool, false)
                    XCTAssertEqual(store.get("glasses", "micEnabled") as? Bool, false)
                    let reconnected = ReconnectRecordingDevice()
                    manager.sgc = reconnected

                    // Replaying the same consumer request is deduplicated. No test
                    // reset of glasses.micEnabled: production teardown must clear it.
                    store.apply("bluetooth", request, true)
                    XCTAssertEqual(store.get("bluetooth", "micEnabled") as? Bool, false)
                    store.apply("glasses", "fullyBooted", true)

                    XCTAssertEqual(store.get("bluetooth", "micEnabled") as? Bool, true, request)
                    XCTAssertEqual(reconnected.micChanges, [true], request)
                    XCTAssertEqual(store.get("bluetooth", "currentMic") as? String, MicTypes.GLASSES_CUSTOM, request)
                }
            }
        }
    }

    func testLinkDisconnectRetainsIntentForTheSameCommunicator() {
        withRecordingDevice { manager, store in
            store.apply("glasses", "fullyBooted", true)
            store.apply("bluetooth", "should_send_lc3", true)
            let original = manager.sgc as! ReconnectRecordingDevice
            store.apply("glasses", "fullyBooted", false)
            XCTAssertTrue((manager.sgc as? ReconnectRecordingDevice) === original)
            XCTAssertEqual(store.get("bluetooth", "should_send_lc3") as? Bool, true)
            XCTAssertEqual(store.get("glasses", "micEnabled") as? Bool, true)
        }
    }

    func testDiscardingCommunicatorInvalidatesMicCache() {
        withRecordingDevice { manager, store in
            store.apply("bluetooth", "should_send_lc3", true)
            manager.initSGC(manager.sgc!.type)
            XCTAssertEqual(store.get("glasses", "micEnabled") as? Bool, true)

            // An unsupported model exercises disposal without starting real BLE.
            manager.initSGC("Unavailable test glasses")
            XCTAssertNil(manager.sgc)
            XCTAssertEqual(store.get("glasses", "micEnabled") as? Bool, false)
            XCTAssertEqual(store.get("bluetooth", "should_send_lc3") as? Bool, true)
        }
    }

    func testReconnectWithoutAudioRequestsLeavesMicOff() {
        withRecordingDevice { manager, store in
            store.set("glasses", "micEnabled", true)
            manager.disconnect()
            XCTAssertEqual(store.get("glasses", "micEnabled") as? Bool, false)
            let reconnected = ReconnectRecordingDevice()
            manager.sgc = reconnected
            store.apply("glasses", "fullyBooted", true)
            XCTAssertEqual(store.get("bluetooth", "micEnabled") as? Bool, false)
            XCTAssertEqual(store.get("bluetooth", "currentMic") as? String, "")
            XCTAssertTrue(reconnected.micChanges.isEmpty)
        }
    }

    func testWatchdogRetriesWhenFirstPacketNeverArrivesAndLimitsRetries() {
        withRecordingDevice { manager, store in
            var now: TimeInterval = 0
            manager.micWatchdogNow = { now }
            store.apply("glasses", "fullyBooted", true)
            store.apply("bluetooth", "should_send_pcm", true)
            let device = manager.sgc as! ReconnectRecordingDevice
            now = 4
            manager.checkAndReinitGlassesMic()
            XCTAssertEqual(device.micChanges, [true])
            now = 5
            manager.checkAndReinitGlassesMic()
            XCTAssertEqual(device.micChanges, [true, true])
            now = 5.1
            manager.checkAndReinitGlassesMic()
            XCTAssertEqual(device.micChanges, [true, true])
            now = 10
            manager.checkAndReinitGlassesMic()
            XCTAssertEqual(device.micChanges, [true, true, true])
        }
    }

    func testDecodedGlassesAudioKeepsWatchdogHealthyAndMissingPacketsAfterwardRetry() {
        withRecordingDevice { manager, store in
            var now: TimeInterval = 0
            manager.micWatchdogNow = { now }
            store.apply("glasses", "fullyBooted", true)
            store.apply("bluetooth", "should_send_pcm", true)
            let device = manager.sgc as! ReconnectRecordingDevice
            // This is the decoded-audio entry point used by Nimo and AR99.
            for tick in 1 ... 10 {
                now = TimeInterval(tick * 10)
                manager.handleGlassesPcm(Data([0, 0]))
                manager.checkAndReinitGlassesMic()
            }
            XCTAssertEqual(device.micChanges, [true])
            now = 104
            manager.checkAndReinitGlassesMic()
            XCTAssertEqual(device.micChanges, [true])
            now = 105
            manager.checkAndReinitGlassesMic()
            XCTAssertEqual(device.micChanges, [true, true])
        }
    }

    func testLc3GlassesAudioKeepsWatchdogHealthy() {
        withRecordingDevice { manager, store in
            var now: TimeInterval = 0
            manager.micWatchdogNow = { now }
            store.apply("glasses", "fullyBooted", true)
            store.apply("bluetooth", "should_send_pcm", true)
            let device = manager.sgc as! ReconnectRecordingDevice
            let lc3 = manager.lc3Converter!.encode(Data(repeating: 0, count: 320), frameSize: 40) as Data
            XCTAssertEqual(lc3.count, 40)
            // G2 and Live deliver LC3 through this entry point, not decoded PCM.
            for tick in 1 ... 10 {
                now = TimeInterval(tick * 10)
                manager.handleGlassesMicData(lc3, 40)
                manager.checkAndReinitGlassesMic()
            }
            XCTAssertEqual(device.micChanges, [true])
        }
    }

    func testPhonePcmAndEmptyGlassesPcmCannotHideAMissingGlassesStream() {
        withRecordingDevice { manager, store in
            var now: TimeInterval = 0
            manager.micWatchdogNow = { now }
            store.apply("glasses", "fullyBooted", true)
            store.apply("bluetooth", "should_send_pcm", true)
            let device = manager.sgc as! ReconnectRecordingDevice
            now = 5
            manager.handlePcm(Data([0, 0]))
            manager.handleGlassesPcm(Data())
            manager.checkAndReinitGlassesMic()
            XCTAssertEqual(device.micChanges, [true, true])
        }
    }

    func testWatchdogRespectsSuspensionAndGivesResumeAFreshDeadline() {
        withRecordingDevice { manager, store in
            var now: TimeInterval = 0
            manager.micWatchdogNow = { now }
            store.apply("glasses", "fullyBooted", true)
            store.apply("bluetooth", "should_send_pcm", true)
            let device = manager.sgc as! ReconnectRecordingDevice
            device.isMicSuspendedForAudio = true
            now = 100
            manager.checkAndReinitGlassesMic()
            XCTAssertEqual(device.micChanges, [true])
            device.isMicSuspendedForAudio = false
            now = 200
            manager.checkAndReinitGlassesMic()
            XCTAssertEqual(device.micChanges, [true])
            now = 205
            manager.checkAndReinitGlassesMic()
            XCTAssertEqual(device.micChanges, [true, true])

            store.apply("bluetooth", "should_send_pcm", false)
            // A late firmware ACK can leave the shared cache true after demand ends.
            store.set("glasses", "micEnabled", true)
            now = 300
            manager.checkAndReinitGlassesMic()
            XCTAssertEqual(device.micChanges, [true, true, false])
        }
    }

    func testWatchdogRespectsOwnAppPlaybackAndPhoneRoute() {
        withRecordingDevice { manager, store in
            var now: TimeInterval = 0
            manager.micWatchdogNow = { now }
            let monitor = PhoneAudioMonitor.getInstance()
            let wasPlaying = monitor.isOwnAppAudioPlaying()
            defer { monitor.setOwnAppAudioPlaying(wasPlaying) }
            monitor.setOwnAppAudioPlaying(false)
            store.apply("glasses", "fullyBooted", true)
            store.apply("bluetooth", "should_send_pcm", true)
            let device = manager.sgc as! ReconnectRecordingDevice
            monitor.setOwnAppAudioPlaying(true)
            now = 100
            manager.checkAndReinitGlassesMic()
            XCTAssertEqual(device.micChanges, [true])
            monitor.setOwnAppAudioPlaying(false)
            store.set("bluetooth", "currentMic", MicTypes.PHONE_INTERNAL)
            now = 200
            manager.checkAndReinitGlassesMic()
            XCTAssertEqual(device.micChanges, [true])
        }
    }

    func testWatchdogDeadlineBelongsToTheCurrentConnection() {
        withRecordingDevice { manager, store in
            var now: TimeInterval = 0
            manager.micWatchdogNow = { now }
            store.apply("glasses", "fullyBooted", true)
            store.apply("bluetooth", "should_send_pcm", true)
            let device = manager.sgc as! ReconnectRecordingDevice
            store.apply("glasses", "fullyBooted", false)
            now = 100
            manager.checkAndReinitGlassesMic()
            XCTAssertEqual(device.micChanges, [true])
            store.apply("glasses", "fullyBooted", true)
            manager.checkAndReinitGlassesMic()
            XCTAssertEqual(device.micChanges, [true])
            now = 105
            manager.checkAndReinitGlassesMic()
            XCTAssertEqual(device.micChanges, [true, true])
        }
    }
}

@MainActor
private final class ReconnectRecordingDevice: SGCManager {
    var onCleanup: (() -> Void)?
    var onDisconnect: (() -> Void)?
    var type = "Reconnect test glasses"
    let hasMic = true
    let showConnectionConfirmation = false
    var micChanges: [Bool] = []
    var positions: [(Int, Int)] = []
    var onPosition: (() -> Void)?
    var isMicSuspendedForAudio = false

    func clearSceneElements(_: [String]) async {}
    func sendTextWall(_: String) async {}
    func applySceneFrame(_: SceneFrame) async {}
    func clearDisplay() {}

    func setMicEnabled(_ enabled: Bool) {
        micChanges.append(enabled)
        DeviceStore.shared.set("glasses", "micEnabled", enabled)
    }

    func sortMicRanking(list: [String]) -> [String] {
        list
    }

    func sendJson(_: [String: Any], wakeUp _: Bool, requireAck _: Bool) {}
    func requestPhoto(_: PhotoRequest) {}
    func startStream(_: [String: Any]) {}
    func stopStream() {}
    func sendStreamKeepAlive(_: [String: Any]) {}
    func startVideoRecording(requestId _: String, save _: Bool, sound _: Bool) {}
    func stopVideoRecording(requestId _: String) {}
    func sendButtonPhotoSettings() {}
    func sendButtonVideoRecordingSettings() {}
    func sendCameraFovSetting() {}
    func sendButtonMaxRecordingTime() {}
    func setBrightness(_: Int, autoMode _: Bool) {}
    func sendText(_: String) async {}
    func sendDoubleTextWall(_: String, _: String) async {}
    func displayBitmap(base64ImageData _: String, x _: Int32?, y _: Int32?, width _: Int32?, height _: Int32?) async -> Bool {
        false
    }

    func showDashboard() {}
    func setDashboardPosition(_ height: Int, _ depth: Int) {
        positions.append((height, depth))
        onPosition?()
    }

    func setHeadUpAngle(_: Int) {}
    func getBatteryStatus() {}
    func setSilentMode(_: Bool) {}
    func exit() {}
    func sendShutdown() {}
    func sendReboot() {}
    func sendRgbLedControl(requestId _: String, packageName _: String?, action _: String, color _: String?, onDurationMs _: Int, offDurationMs _: Int, count _: Int) {}
    func disconnect() { onDisconnect?() }
    func forget() {}
    func findCompatibleDevices() {}
    func stopScan() {}
    func connectById(_: String) {}
    func getConnectedBluetoothName() -> String? {
        nil
    }

    func cleanup() { onCleanup?() }
    func ping() {}
    func dbg1() {}
    func dbg2() {}
    func connectController() {}
    func disconnectController() {}
    func requestWifiScan(scanId _: String?) {}
    func sendWifiCredentials(_: String, _: String) {}
    func forgetWifiNetwork(_: String) {}
    func sendHotspotState(_: Bool) {}
    func sendUserEmailToGlasses(_: String) {}
    func sendOtaStart(otaVersionUrl _: String?) {}
    func sendOtaQueryStatus() {}
    func queryGalleryStatus() {}
    func sendGalleryMode() {}
    func requestVersionInfo() {}
    func sendIncidentId(_: String, apiBaseUrl _: String?) {}
}
