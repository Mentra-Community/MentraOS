#if os(macOS)
    import AudioUnit
    import AVFoundation
    import CoreAudio
    import Foundation

    @MainActor
    final class PhoneMic {
        static let shared = PhoneMic()
        private var engine: AVAudioEngine?
        private var configurationObserver: NSObjectProtocol?
        private var currentMode = ""
        private var preferredDevice: AudioDeviceID?
        private var activeDevice: AudioDeviceID?
        var isRecording: Bool {
            engine?.isRunning == true
        }

        func checkPermissions() -> Bool {
            AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
        }

        func requestPermissions() async -> Bool {
            checkPermissions()
        }

        func getAvailableInputDevices() -> [String: String] {
            Dictionary(uniqueKeysWithValues: MacAudioDevice.available.filter(\.hasInput).map { (String($0.id), $0.name) })
        }

        func setPreferredInputDevice(named name: String) -> Bool {
            guard let device = MacAudioDevice.available.first(where: { $0.hasInput && $0.name.localizedCaseInsensitiveContains(name) })
            else { return false }
            preferredDevice = device.id
            if isRecording {
                let mode = currentMode
                stopRecording()
                return startMode(mode)
            }
            return true
        }

        func isRecordingWithMode(_ mode: String) -> Bool {
            isRecording && currentMode == mode
        }

        func startMode(_ mode: String) -> Bool {
            if isRecordingWithMode(mode) { return true }
            guard !isRecording, checkPermissions() else { return false }
            let inputs = MacAudioDevice.available.filter(\.hasInput)
            let device: AudioDeviceID?
            switch mode {
            case MicTypes.PHONE_INTERNAL:
                device = inputs.first(where: { $0.id == preferredDevice })?.id
                    ?? inputs.first(where: { $0.transport == kAudioDeviceTransportTypeBuiltIn })?.id
                    ?? MacAudioDevice.defaultInput
            case MicTypes.BLUETOOTH, MicTypes.BLUETOOTH_CLASSIC:
                device = inputs.first(where: { $0.isBluetooth && $0.id == preferredDevice })?.id
                    ?? inputs.first(where: \.isBluetooth)?.id
            default:
                return false
            }
            guard let device else { return false }
            return start(device: device, mode: mode)
        }

        func startRecording() -> Bool {
            startMode(MicTypes.PHONE_INTERNAL)
        }

        private func start(device: AudioDeviceID, mode: String) -> Bool {
            let engine = AVAudioEngine()
            let input = engine.inputNode
            guard let unit = input.audioUnit else { return false }
            var device = device
            guard AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global,
                                       0, &device, UInt32(MemoryLayout<AudioDeviceID>.size)) == noErr
            else { return false }
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0, format.channelCount > 0,
                  let output = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: false),
                  let converter = AVAudioConverter(from: format, to: output)
            else { return false }
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self, weak engine] buffer, _ in
                let capacity = AVAudioFrameCount(ceil(Double(buffer.frameLength) * output.sampleRate / format.sampleRate))
                guard let converted = AVAudioPCMBuffer(pcmFormat: output, frameCapacity: capacity) else { return }
                var supplied = false
                var error: NSError?
                let result = converter.convert(to: converted, error: &error) { _, status in
                    guard !supplied else { status.pointee = .noDataNow; return nil }
                    supplied = true
                    status.pointee = .haveData
                    return buffer
                }
                guard result != .error, error == nil, converted.frameLength > 0,
                      let samples = converted.int16ChannelData?[0] else { return }
                let pcm = Data(bytes: samples, count: Int(converted.frameLength) * MemoryLayout<Int16>.size)
                Task { @MainActor [weak self, weak engine] in
                    guard let engine, self?.engine === engine else { return }
                    DeviceManager.shared.handlePcm(pcm)
                }
            }
            do {
                try engine.start()
            } catch {
                input.removeTap(onBus: 0)
                Bridge.log("MIC: macOS input failed: \(error.localizedDescription)")
                return false
            }
            self.engine = engine
            activeDevice = device
            currentMode = mode
            configurationObserver = NotificationCenter.default.addObserver(
                forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main
            ) { [weak self, weak engine] _ in
                Task { @MainActor in
                    guard let engine, self?.engine === engine else { return }
                    self?.stopRecording()
                    DeviceManager.shared.updateMicState()
                }
            }
            return true
        }

        func getActiveInputDevice() -> String? {
            MacAudioDevice.available.first(where: { $0.id == activeDevice })?.name
        }

        func stopMode(_ mode: String) -> Bool {
            guard currentMode == mode else { return false }
            stopRecording()
            return true
        }

        func stopRecording() {
            if let configurationObserver {
                NotificationCenter.default.removeObserver(configurationObserver)
            }
            configurationObserver = nil
            engine?.inputNode.removeTap(onBus: 0)
            engine?.stop()
            engine = nil
            currentMode = ""
            activeDevice = nil
        }

        func cleanup() {
            stopRecording()
        }
    }
#endif
