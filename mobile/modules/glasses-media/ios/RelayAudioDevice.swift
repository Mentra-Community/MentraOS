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
    private let condition = NSCondition()
    private var quitting = false
    private var exited = true
    private var recording = false

    func initialize(with delegate: RTCAudioDeviceDelegate) -> Bool {
        condition.lock(); quitting = false; recording = false; exited = false; condition.unlock()
        isInitialized = true
        let thread = Thread { [self, delegate] in
            let storage = UnsafeMutablePointer<Int16>.allocate(capacity: 480)
            defer {
                storage.deallocate()
                condition.lock(); exited = true; condition.broadcast(); condition.unlock()
            }
            var sampleTime: Double = 0
            var next = ProcessInfo.processInfo.systemUptime
            while true {
                condition.lock()
                while !recording && !quitting {
                    condition.wait(); next = ProcessInfo.processInfo.systemUptime
                }
                let stop = quitting
                condition.unlock()
                if stop { return }
                pcm.read(into: UnsafeMutableBufferPointer(start: storage, count: 480))
                var flags = AudioUnitRenderActionFlags()
                var stamp = AudioTimeStamp()
                stamp.mSampleTime = sampleTime
                stamp.mFlags = .sampleTimeValid
                var buffers = AudioBufferList(mNumberBuffers: 1, mBuffers: AudioBuffer(mNumberChannels: 1, mDataByteSize: 960, mData: storage))
                _ = delegate.deliverRecordedData(&flags, &stamp, 0, 480, &buffers, nil, nil)
                sampleTime += 480
                next += 0.01
                let now = ProcessInfo.processInfo.systemUptime
                if next > now { Thread.sleep(forTimeInterval: next - now) }
                else if now - next > 0.1 { next = now }
            }
        }
        thread.name = "Mentra glasses audio publish"
        thread.qualityOfService = .userInitiated
        thread.start()
        return true
    }

    func terminateDevice() -> Bool {
        condition.lock(); quitting = true; recording = false; condition.broadcast()
        while !exited {
            condition.wait()
        }
        condition.unlock()
        isInitialized = false; isRecording = false; isRecordingInitialized = false
        return true
    }

    func initializeRecording() -> Bool {
        isRecordingInitialized = true; return true
    }

    func startRecording() -> Bool {
        condition.lock(); recording = true; condition.broadcast(); condition.unlock()
        isRecording = true; return true
    }

    func stopRecording() -> Bool {
        condition.lock(); recording = false; condition.unlock()
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
