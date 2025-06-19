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
        private var buffer: [Bool] = []

        init(size: Int) {
            self.size = size
        }

        func append(_ isSpeech: Bool) {
            buffer.append(isSpeech)
            buffer = buffer.suffix(size)
        }

        func isAllSpeech() -> Bool {
            return buffer.count == size && buffer.allSatisfy { $0 }
        }

        func isAllNotSpeech() -> Bool {
            return buffer.count == size && buffer.allSatisfy { !$0 }
        }
    }
    // 支持两种采样率，不同的采样率时，支持的 windowSizeSmaple 不一样
    // sample rate: 8000;  sliceSize: 256/512/768
    // sample rate: 16000; sliceSize: 512/1024/1536

    static var modelPath: String {
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

    /**
     * sampleRate: 16000, 8000
     * sliceSize:
     *     - sampleRate: 8000; sliceSize: 256, 512, 768
     *     - sampleRate: 16000; sliceSize: 512, 1024, 1536
     */
    public init(sampleRate: Int64, sliceSize: Int64, threshold: Float, silenceTriggerDurationMs: Int64, speechTriggerDurationMs: Int64, modelPath: String = "") {
        self.sampleRate = sampleRate
        self.sliceSizeSamples = sliceSize
        self.threshold = threshold

        let samplesPerMs = sampleRate / 1000
        let silenceBufferSize = Int(ceil(Float(samplesPerMs * silenceTriggerDurationMs) / Float(sliceSize)))
        let speechBufferSize = Int(ceil(Float(samplesPerMs * speechTriggerDurationMs) / Float(sliceSize)))
        self.silenceBuffer = InternalBuffer(size: silenceBufferSize)
        self.speechBuffer = InternalBuffer(size: speechBufferSize)

        self.hidden = Array(repeating: Array(repeating: Array(repeating: Float(0.0), count: 64), count: 1), count: 2)
        self.cell = Array(repeating: Array(repeating: Array(repeating: Float(0.0), count: 64), count: 1), count: 2)

        do {
            self.env = try? ORTEnv(loggingLevel: .warning)
            let sessionOptions = try? ORTSessionOptions()
            try sessionOptions?.setIntraOpNumThreads(1)
            try sessionOptions?.setGraphOptimizationLevel(.all)
            let path: String
            if modelPath.isEmpty {
                path = Self.modelPath
            } else {
                path = modelPath
            }
            let session = try? ORTSession(env: self.env!, modelPath: path, sessionOptions: sessionOptions!)
            self.session = session!
        } catch {
            fatalError()
        }
        super.init()
        debugLog("SampleRate = \(sampleRate); sliceSize = \(sliceSize); threshold = \(threshold); silenceTriggerDurationMs = \(silenceTriggerDurationMs); speechTriggerDurationMs = \(speechTriggerDurationMs)")
    }

    public func resetState() {
        hidden = Array(repeating: Array(repeating: Array(repeating: Float(0.0), count: 64), count: 1), count: 2)
        cell = Array(repeating: Array(repeating: Array(repeating: Float(0.0), count: 64), count: 1), count: 2)
    }

    public func predict(data: [Float]) throws {
        let inputShape: [NSNumber] = [1, NSNumber(value: sliceSizeSamples)]
        // 输入长度 sliceSize * 2 bytes
        let inputTensor = try ORTValue(tensorData: NSMutableData(bytes: data, length: Int(sliceSizeSamples) * MemoryLayout<Float>.size), elementType: .float, shape: inputShape)
        let srTensor = try ORTValue(tensorData: NSMutableData(bytes: [sampleRate], length: MemoryLayout<Int64>.size), elementType: .int64, shape: [1])
        let hTensor = try ORTValue(tensorData: NSMutableData(bytes: hidden.flatMap { $0.flatMap { $0 } }, length: hcSize * MemoryLayout<Float>.size), elementType: .float, shape: [2, 1, 64])
        let cTensor = try ORTValue(tensorData: NSMutableData(bytes: cell.flatMap { $0.flatMap { $0 } }, length: hcSize * MemoryLayout<Float>.size), elementType: .float, shape: [2, 1, 64])

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
        hiddenData.withUnsafeBytes { (buffer: UnsafeRawBufferPointer) -> Void in
            let floatBuffer = buffer.bindMemory(to: Float.self)
            for i in 0..<hc_shape.0 {
                for j in 0..<hc_shape.1 {
                    for k in 0..<hc_shape.2 {
                        hidden[i][j][k] = floatBuffer[i * hc_shape.1 * hc_shape.2 + j * hc_shape.2 + k]
                    }
                }
            }
        }

        let cellData = try cellValue.tensorData() as Data
        cellData.withUnsafeBytes { (buffer: UnsafeRawBufferPointer) -> Void in
            let floatBuffer = buffer.bindMemory(to: Float.self)
            for i in 0..<hc_shape.0 {
                for j in 0..<hc_shape.1 {
                    for k in 0..<hc_shape.2 {
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

    private func debugLog(_ content: String) {
        #if DEBUG
//        print("[Silero VAD]: " + content)
        #endif
    }
}

extension Data {
    // 针对采样位数为 16 位的情况
    public func int16Array() -> [Int16] {
        var array = [Int16](repeating: 0, count: self.count / MemoryLayout<Int16>.stride)
        _ = array.withUnsafeMutableBytes {
            self.copyBytes(to: $0, from: 0..<count)
        }
        return array
    }
}
