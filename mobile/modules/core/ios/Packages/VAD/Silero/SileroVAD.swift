//
//  SileroVAD.swift
//  ios-vad
//
//  Created by baochuquan on 2024/11/9.
//

import Foundation
import onnxruntime_objc

public protocol SileroVADDelegate: AnyObject {
    func sileroVADDidDetectSpeechStart()
    func sileroVADDidDetectSpeechEnd()
    func sileroVADDidDetectSpeeching()
    func sileroVADDidDetectSilence()
}

public class SileroVAD: NSObject {
    private enum State {
        case silence
        case start
        case speeching
        case end
    }

    private class InternalBuffer {
        private let size: Int
        // Use ContiguousArray for better memory layout and to avoid copy-on-write issues
        // when the array buffer is accessed from multiple threads
        private var buffer: ContiguousArray<Bool>
        private let lock = NSLock()

        init(size: Int) {
            self.size = size
            // Pre-allocate capacity to minimize reallocations
            buffer = ContiguousArray<Bool>()
            buffer.reserveCapacity(size + 1)
        }

        func append(_ isSpeech: Bool) {
            lock.lock()
            // Perform all mutations while holding the lock
            if buffer.count >= size {
                // Remove oldest elements to make room
                let removeCount = buffer.count - size + 1
                buffer.removeFirst(removeCount)
            }
            buffer.append(isSpeech)
            lock.unlock()
        }

        func isAllSpeech() -> Bool {
            lock.lock()
            // Copy the values we need while holding the lock
            let count = buffer.count
            let targetSize = size
            let allTrue = count == targetSize && !buffer.contains(false)
            lock.unlock()
            return allTrue
        }

        func isAllNotSpeech() -> Bool {
            lock.lock()
            // Copy the values we need while holding the lock
            let count = buffer.count
            let targetSize = size
            let allFalse = count == targetSize && !buffer.contains(true)
            lock.unlock()
            return allFalse
        }
    }

    // 支持两种采样率，不同的采样率时，支持的 windowSizeSmaple 不一样
    // sample rate: 8000;  sliceSize: 256/512/768
    // sample rate: 16000; sliceSize: 512/1024/1536

    static var modelPath: String {
        // Try to find the model in the bundle containing this class (for CocoaPods)
        let bundle = Bundle(for: SileroVAD.self)
        if let path = bundle.path(forResource: "silero_vad", ofType: "onnx") {
            return path
        }
        // Fall back to main bundle
        return Bundle.main.path(forResource: "silero_vad", ofType: "onnx") ?? ""
    }

    public weak var delegate: SileroVADDelegate?
    // 配置参数
    private let sampleRate: Int64
    private let sliceSizeSamples: Int64
    private let threshold: Float
    // 内部状态
    private var state: State = .silence
    private var silenceBuffer: InternalBuffer
    private var speechBuffer: InternalBuffer

    // 神经网络迭代状态
    private var hidden: [[[Float]]]
    private var cell: [[[Float]]]
    private let hcSize: Int = 2 * 1 * 64

    private var env: ORTEnv?
    private var session: ORTSession

    // Pre-allocated buffers to avoid creating new objects every frame (memory leak fix)
    private var inputData: NSMutableData!
    private var srData: NSMutableData!
    private var hData: NSMutableData!
    private var cData: NSMutableData!

    /**
     * sampleRate: 16000, 8000
     * sliceSize:
     *     - sampleRate: 8000; sliceSize: 256, 512, 768
     *     - sampleRate: 16000; sliceSize: 512, 1024, 1536
     */
    public init(sampleRate: Int64, sliceSize: Int64, threshold: Float, silenceTriggerDurationMs: Int64, speechTriggerDurationMs: Int64, modelPath: String = "") {
        self.sampleRate = sampleRate
        sliceSizeSamples = sliceSize
        self.threshold = threshold

        let samplesPerMs = sampleRate / 1000
        let silenceBufferSize = Int(ceil(Float(samplesPerMs * silenceTriggerDurationMs) / Float(sliceSize)))
        let speechBufferSize = Int(ceil(Float(samplesPerMs * speechTriggerDurationMs) / Float(sliceSize)))
        silenceBuffer = InternalBuffer(size: silenceBufferSize)
        speechBuffer = InternalBuffer(size: speechBufferSize)

        hidden = Array(repeating: Array(repeating: Array(repeating: Float(0.0), count: 64), count: 1), count: 2)
        cell = Array(repeating: Array(repeating: Array(repeating: Float(0.0), count: 64), count: 1), count: 2)

        do {
            env = try? ORTEnv(loggingLevel: .warning)
            let sessionOptions = try? ORTSessionOptions()
            try sessionOptions?.setIntraOpNumThreads(1)
            try sessionOptions?.setGraphOptimizationLevel(.all)
            let path: String
            if modelPath.isEmpty {
                path = Self.modelPath
            } else {
                path = modelPath
            }
            let session = try? ORTSession(env: env!, modelPath: path, sessionOptions: sessionOptions!)
            self.session = session!
        } catch {
            fatalError()
        }

        // Pre-allocate reusable buffers for ONNX inference (prevents memory leak)
        inputData = NSMutableData(length: Int(sliceSize) * MemoryLayout<Float>.size)!
        srData = NSMutableData(bytes: [sampleRate], length: MemoryLayout<Int64>.size)
        hData = NSMutableData(length: hcSize * MemoryLayout<Float>.size)!
        cData = NSMutableData(length: hcSize * MemoryLayout<Float>.size)!

        super.init()
        debugLog("SampleRate = \(sampleRate); sliceSize = \(sliceSize); threshold = \(threshold); silenceTriggerDurationMs = \(silenceTriggerDurationMs); speechTriggerDurationMs = \(speechTriggerDurationMs)")
    }

    public func resetState() {
        hidden = Array(repeating: Array(repeating: Array(repeating: Float(0.0), count: 64), count: 1), count: 2)
        cell = Array(repeating: Array(repeating: Array(repeating: Float(0.0), count: 64), count: 1), count: 2)
    }

    public func predict(data: [Float]) throws {
        let inputShape: [NSNumber] = [1, NSNumber(value: sliceSizeSamples)]

        // Copy input data into pre-allocated buffer (reuse buffer to avoid memory leak)
        data.withUnsafeBytes { ptr in
            inputData.replaceBytes(in: NSRange(location: 0, length: inputData.length), withBytes: ptr.baseAddress!)
        }

        // Copy hidden state into pre-allocated buffer
        let flatHidden = hidden.flatMap { $0.flatMap { $0 } }
        flatHidden.withUnsafeBytes { ptr in
            hData.replaceBytes(in: NSRange(location: 0, length: hData.length), withBytes: ptr.baseAddress!)
        }

        // Copy cell state into pre-allocated buffer
        let flatCell = cell.flatMap { $0.flatMap { $0 } }
        flatCell.withUnsafeBytes { ptr in
            cData.replaceBytes(in: NSRange(location: 0, length: cData.length), withBytes: ptr.baseAddress!)
        }

        // Create tensors from pre-allocated buffers (ORTValue creation is unavoidable but buffers are reused)
        let inputTensor = try ORTValue(tensorData: inputData, elementType: .float, shape: inputShape)
        let srTensor = try ORTValue(tensorData: srData, elementType: .int64, shape: [1])
        let hTensor = try ORTValue(tensorData: hData, elementType: .float, shape: [2, 1, 64])
        let cTensor = try ORTValue(tensorData: cData, elementType: .float, shape: [2, 1, 64])

        let outputTensor = try session.run(
            withInputs: ["input": inputTensor, "sr": srTensor, "h": hTensor, "c": cTensor],
            outputNames: ["output", "hn", "cn"],
            runOptions: nil
        )
        guard let outputValue = outputTensor["output"], let hiddenValue = outputTensor["hn"], let cellValue = outputTensor["cn"] else {
            throw NSError(domain: "VadIterator", code: 1, userInfo: nil)
        }

        let outputData = try outputValue.tensorData() as Data
        let probability = outputData.withUnsafeBytes { (buffer: UnsafeRawBufferPointer) -> Float in
            let floatBuffer = buffer.bindMemory(to: Float.self)
            return floatBuffer[0]
        }

        let hc_shape = (2, 1, 64)

        let hiddenData = try hiddenValue.tensorData() as Data
        hiddenData.withUnsafeBytes { (buffer: UnsafeRawBufferPointer) in
            let floatBuffer = buffer.bindMemory(to: Float.self)
            for i in 0 ..< hc_shape.0 {
                for j in 0 ..< hc_shape.1 {
                    for k in 0 ..< hc_shape.2 {
                        hidden[i][j][k] = floatBuffer[i * hc_shape.1 * hc_shape.2 + j * hc_shape.2 + k]
                    }
                }
            }
        }

        let cellData = try cellValue.tensorData() as Data
        cellData.withUnsafeBytes { (buffer: UnsafeRawBufferPointer) in
            let floatBuffer = buffer.bindMemory(to: Float.self)
            for i in 0 ..< hc_shape.0 {
                for j in 0 ..< hc_shape.1 {
                    for k in 0 ..< hc_shape.2 {
                        cell[i][j][k] = floatBuffer[i * hc_shape.1 * hc_shape.2 + j * hc_shape.2 + k]
                    }
                }
            }
        }

        let isSpeech = probability > threshold
        if isSpeech {
            debugLog("\(timestamp()) prob -> \(probability), true")
        } else {
            debugLog("\(timestamp()) prob -> \(probability)")
        }

        // 缓存结果
        silenceBuffer.append(isSpeech)
        speechBuffer.append(isSpeech)
        // 状态迁移
        switch state {
        case .silence:
            if speechBuffer.isAllSpeech() {
                state = .start
                delegate?.sileroVADDidDetectSpeechStart()
                state = .speeching
                delegate?.sileroVADDidDetectSpeeching()
            }
        case .speeching:
            if silenceBuffer.isAllNotSpeech() {
                state = .end
                delegate?.sileroVADDidDetectSpeechEnd()
                state = .silence
                delegate?.sileroVADDidDetectSilence()
            }
        default:
            break
        }
    }

    private func timestamp() -> String {
        let date = Date()
        let dateFormatter = DateFormatter()
        dateFormatter.dateFormat = "HH:mm:ss.SSS"
        return dateFormatter.string(from: date)
    }

    private func debugLog(_: String) {
        #if DEBUG
//        print("[Silero VAD]: " + content)
        #endif
    }
}

public extension Data {
    // 针对采样位数为 16 位的情况
    func int16Array() -> [Int16] {
        var array = [Int16](repeating: 0, count: count / MemoryLayout<Int16>.stride)
        _ = array.withUnsafeMutableBytes {
            self.copyBytes(to: $0, from: 0 ..< count)
        }
        return array
    }
}
