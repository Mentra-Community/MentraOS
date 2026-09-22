import AudioToolbox
import Foundation
import WebRTC

/// Pulls the receive mixer on a dedicated thread so remote PCM renderers run, but never opens
/// the phone microphone, loudspeaker, or AVAudioSession. The publisher owns audio routing.
final class ReceiveOnlyAudioDevice: NSObject, RTCAudioDevice {
    let deviceInputSampleRate: Double = 48000
    let inputIOBufferDuration: TimeInterval = 0.01
    let inputNumberOfChannels = 1
    let inputLatency: TimeInterval = 0
    let deviceOutputSampleRate: Double = 48000
    let outputIOBufferDuration: TimeInterval = 0.01
    let outputNumberOfChannels = 1
    let outputLatency: TimeInterval = 0
    private(set) var isInitialized = false
    private(set) var isPlayoutInitialized = false
    private(set) var isPlaying = false
    let isRecordingInitialized = false
    let isRecording = false
    private let condition = NSCondition()
    private var quitting = false
    private var exited = true
    private var playing = false

    func initialize(with delegate: RTCAudioDeviceDelegate) -> Bool {
        condition.lock()
        quitting = false
        playing = false
        exited = false
        condition.unlock()
        isInitialized = true
        let thread = Thread { [self, delegate] in
            let storage = UnsafeMutablePointer<Int16>.allocate(capacity: 480)
            defer {
                storage.deallocate()
                condition.lock(); exited = true; condition.broadcast(); condition.unlock()
            }
            var sampleTime: Double = 0
            while true {
                condition.lock()
                while !playing && !quitting {
                    condition.wait()
                }
                let stop = quitting
                condition.unlock()
                if stop { return }
                var flags = AudioUnitRenderActionFlags()
                var stamp = AudioTimeStamp()
                stamp.mSampleTime = sampleTime
                stamp.mFlags = .sampleTimeValid
                var buffers = AudioBufferList(mNumberBuffers: 1, mBuffers: AudioBuffer(mNumberChannels: 1, mDataByteSize: 960, mData: storage))
                _ = delegate.getPlayoutData(&flags, &stamp, 0, 480, &buffers)
                sampleTime += 480
                Thread.sleep(forTimeInterval: 0.01)
            }
        }
        thread.name = "Mentra local audio receive"
        thread.qualityOfService = .userInitiated
        thread.start()
        return true
    }

    func terminateDevice() -> Bool {
        condition.lock()
        quitting = true
        playing = false
        condition.broadcast()
        while !exited {
            condition.wait()
        }
        condition.unlock()
        isInitialized = false
        isPlaying = false
        isPlayoutInitialized = false
        return true
    }

    func initializePlayout() -> Bool {
        isPlayoutInitialized = true; return true
    }

    func startPlayout() -> Bool {
        condition.lock(); playing = true; condition.broadcast(); condition.unlock()
        isPlaying = true
        return true
    }

    func stopPlayout() -> Bool {
        condition.lock(); playing = false; condition.unlock()
        isPlaying = false
        return true
    }

    func initializeRecording() -> Bool {
        false
    }

    func startRecording() -> Bool {
        false
    }

    func stopRecording() -> Bool {
        true
    }
}
