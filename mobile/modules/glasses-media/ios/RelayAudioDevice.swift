import AudioToolbox
import Foundation
import WebRTC

/// WebRTC recording device driven by decoded glasses PCM. No phone mic or AVAudioSession capture.
final class RelayAudioDevice: NSObject, RTCAudioDevice {
    let pcm = RelayPcmBuffer()
    let deviceInputSampleRate: Double = 48000
    let inputIOBufferDuration: TimeInterval = 0.01
    let inputNumberOfChannels = 1
    let inputLatency: TimeInterval = 0
    let deviceOutputSampleRate: Double = 48000
    let outputIOBufferDuration: TimeInterval = 0.01
    let outputNumberOfChannels = 1
    let outputLatency: TimeInterval = 0
    private(set) var isInitialized = false
    private(set) var isRecordingInitialized = false
    private(set) var isRecording = false
    let isPlayoutInitialized = false
    let isPlaying = false
    private let clock = RelayAudioClock()

    func initialize(with delegate: RTCAudioDeviceDelegate) -> Bool {
        let storage = UnsafeMutablePointer<Int16>.allocate(capacity: 480)
        let pcm = pcm
        clock.start(render: { sampleTime in
            pcm.read(into: UnsafeMutableBufferPointer(start: storage, count: 480))
            var flags = AudioUnitRenderActionFlags()
            var stamp = AudioTimeStamp()
            stamp.mSampleTime = sampleTime
            stamp.mFlags = .sampleTimeValid
            var buffers = AudioBufferList(mNumberBuffers: 1, mBuffers: AudioBuffer(mNumberChannels: 1, mDataByteSize: 960, mData: storage))
            _ = delegate.deliverRecordedData(&flags, &stamp, 0, 480, &buffers, nil, nil)
        }, finish: { storage.deallocate() })
        isInitialized = true
        return true
    }

    func terminateDevice() -> Bool {
        clock.stop()
        isInitialized = false; isRecording = false; isRecordingInitialized = false
        return true
    }

    func initializeRecording() -> Bool {
        isRecordingInitialized = true; return true
    }

    func startRecording() -> Bool {
        clock.setEnabled(true)
        isRecording = true; return true
    }

    func stopRecording() -> Bool {
        clock.setEnabled(false)
        isRecording = false; return true
    }

    func initializePlayout() -> Bool {
        false
    }

    func startPlayout() -> Bool {
        false
    }

    func stopPlayout() -> Bool {
        true
    }
}
