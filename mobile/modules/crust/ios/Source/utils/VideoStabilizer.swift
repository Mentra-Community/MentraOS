import AVFoundation
import CoreImage
import Foundation

/// Gyroscope-based video stabilizer.
/// Uses IMU sidecar data to apply motion-compensated frame warping,
/// correcting rotation jitter in videos.
///
/// Phase 1: rotation correction (pan/tilt/roll) using gyro integration
/// + exponential moving average smoothing.
class VideoStabilizer {
    private static let TAG = "VideoStabilizer"
    private static let SMOOTH_FACTOR = 0.98
    private static let SMOOTH_PASSES = 3
    private static let CROP_MARGIN = 0.08

    struct ImuSample {
        let timeMs: Double
        let ax: Double
        let ay: Double
        let az: Double
        let gx: Double
        let gy: Double
        let gz: Double
    }

    /// Stabilize a video using IMU sidecar data.
    /// - Parameters:
    ///   - inputPath: Path to the input MP4 video
    ///   - imuPath: Path to the IMU sidecar JSON file
    ///   - outputPath: Path to write the stabilized MP4
    /// - Returns: Processing time in milliseconds, or -1 on failure
    static func stabilize(inputPath: String, imuPath: String, outputPath: String) -> Int64 {
        let startTime = CFAbsoluteTimeGetCurrent()

        // Parse IMU data
        guard let imuSamples = parseImuData(imuPath), !imuSamples.isEmpty else {
            NSLog("\(TAG): No IMU data available")
            return -1
        }
        NSLog("\(TAG): Loaded \(imuSamples.count) IMU samples")

        // Integrate gyro data to get cumulative rotation (3 axes)
        var cumulativeRoll = [Double](repeating: 0, count: imuSamples.count)
        var cumulativePitch = [Double](repeating: 0, count: imuSamples.count)
        var cumulativeYaw = [Double](repeating: 0, count: imuSamples.count)

        for i in 1 ..< imuSamples.count {
            var dt = (imuSamples[i].timeMs - imuSamples[i - 1].timeMs) / 1000.0
            if dt <= 0 || dt > 0.1 { dt = 0.01 }

            cumulativeRoll[i] = cumulativeRoll[i - 1] + imuSamples[i].gx * dt
            cumulativePitch[i] = cumulativePitch[i - 1] + imuSamples[i].gy * dt
            cumulativeYaw[i] = cumulativeYaw[i - 1] + imuSamples[i].gz * dt
        }

        // Smooth with multi-pass bidirectional EMA for aggressive stabilization
        let smoothRoll = smoothEmaMultiPass(cumulativeRoll)
        let smoothPitch = smoothEmaMultiPass(cumulativePitch)
        let smoothYaw = smoothEmaMultiPass(cumulativeYaw)

        // Correction = smooth - actual
        var corrRoll = [Double](repeating: 0, count: imuSamples.count)
        var corrPitch = [Double](repeating: 0, count: imuSamples.count)
        var corrYaw = [Double](repeating: 0, count: imuSamples.count)
        for i in 0 ..< imuSamples.count {
            corrRoll[i] = smoothRoll[i] - cumulativeRoll[i]
            corrPitch[i] = smoothPitch[i] - cumulativePitch[i]
            corrYaw[i] = smoothYaw[i] - cumulativeYaw[i]
        }

        // Setup AVAsset reader/writer pipeline
        let inputURL = URL(fileURLWithPath: inputPath)
        let outputURL = URL(fileURLWithPath: outputPath)

        // Remove output if it exists
        try? FileManager.default.removeItem(at: outputURL)

        let asset = AVAsset(url: inputURL)

        guard let videoTrack = asset.tracks(withMediaType: .video).first else {
            NSLog("\(TAG): No video track found")
            return -1
        }

        let videoSize = videoTrack.naturalSize
        let frameRate = videoTrack.nominalFrameRate
        let videoDuration = CMTimeGetSeconds(asset.duration)
        let imuDurationMs = imuSamples.last?.timeMs ?? 1.0

        NSLog(
            "\(TAG): Video \(Int(videoSize.width))x\(Int(videoSize.height)) fps=\(frameRate) duration=\(videoDuration)s"
        )

        // Setup reader
        guard let reader = try? AVAssetReader(asset: asset) else {
            NSLog("\(TAG): Failed to create AVAssetReader")
            return -1
        }

        let readerSettings: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        ]
        let readerOutput = AVAssetReaderTrackOutput(track: videoTrack, outputSettings: readerSettings)
        reader.add(readerOutput)

        // Setup writer
        guard let writer = try? AVAssetWriter(outputURL: outputURL, fileType: .mp4) else {
            NSLog("\(TAG): Failed to create AVAssetWriter")
            return -1
        }

        let writerSettings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: Int(videoSize.width),
            AVVideoHeightKey: Int(videoSize.height),
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: Int(videoTrack.estimatedDataRate),
                AVVideoMaxKeyFrameIntervalKey: 30,
            ],
        ]
        let videoFormatHint = videoTrack.formatDescriptions.first.map { $0 as! CMFormatDescription }
        let writerInput = AVAssetWriterInput(
            mediaType: .video, outputSettings: writerSettings, sourceFormatHint: videoFormatHint
        )
        writerInput.transform = videoTrack.preferredTransform

        let adaptor = AVAssetWriterInputPixelBufferAdaptor(
            assetWriterInput: writerInput,
            sourcePixelBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey as String: Int(videoSize.width),
                kCVPixelBufferHeightKey as String: Int(videoSize.height),
            ]
        )
        writer.add(writerInput)

        // Copy audio track if present
        var audioWriterInput: AVAssetWriterInput?
        var audioReaderOutput: AVAssetReaderTrackOutput?
        if let audioTrack = asset.tracks(withMediaType: .audio).first {
            let audioOutput = AVAssetReaderTrackOutput(track: audioTrack, outputSettings: nil)
            reader.add(audioOutput)
            audioReaderOutput = audioOutput

            let audioFormatHint = audioTrack.formatDescriptions.first.map { $0 as! CMFormatDescription }
            let audioInput = AVAssetWriterInput(
                mediaType: .audio, outputSettings: nil, sourceFormatHint: audioFormatHint
            )
            writer.add(audioInput)
            audioWriterInput = audioInput
        }

        // Start processing
        reader.startReading()
        writer.startWriting()
        writer.startSession(atSourceTime: .zero)

        let ciContext = CIContext(options: [.useSoftwareRenderer: false])
        var frameCount = 0

        // Process video frames
        let videoGroup = DispatchGroup()
        videoGroup.enter()

        writerInput.requestMediaDataWhenReady(on: DispatchQueue(label: "videoStabilizer.video")) {
            while writerInput.isReadyForMoreMediaData {
                guard let sampleBuffer = readerOutput.copyNextSampleBuffer() else {
                    writerInput.markAsFinished()
                    videoGroup.leave()
                    return
                }

                // autoreleasepool prevents CIImage/CIFilter intermediates from accumulating
                // in the tight while loop, which otherwise causes OOM crashes on longer videos.
                autoreleasepool {
                    let presentationTime = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
                    let frameTimeMs = CMTimeGetSeconds(presentationTime) * 1000.0

                    // Find correction for this frame
                    let ratio = imuDurationMs > 0 ? frameTimeMs / imuDurationMs : 0
                    let imuIdx = max(0, min(Int(ratio * Double(imuSamples.count - 1)), imuSamples.count - 1))

                    let rollCorr = corrRoll[imuIdx]
                    let pitchCorr = corrPitch[imuIdx]
                    let yawCorr = corrYaw[imuIdx]

                    guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
                    var ciImage = CIImage(cvPixelBuffer: pixelBuffer)

                    // Apply color corrections (same pipeline as ImageProcessor)
                    ciImage = applyToneCurve(ciImage)
                    ciImage = applyVibrance(ciImage)
                    ciImage = applyColorCorrection(ciImage)

                    // Always apply crop+scale for consistent framing, plus stabilization correction
                    let cx = videoSize.width / 2
                    let cy = videoSize.height / 2
                    let scale = 1.0 / (1.0 - 2.0 * CROP_MARGIN)

                    // Clamp corrections to the crop margin so we never show black edges
                    let maxShiftX = CROP_MARGIN * Double(videoSize.width)
                    let maxShiftY = CROP_MARGIN * Double(videoSize.height)
                    let maxRollRad = CROP_MARGIN * 0.5

                    let clampedRoll = min(max(rollCorr, -maxRollRad), maxRollRad)
                    let clampedPitchShift = min(max(-pitchCorr * Double(cx), -maxShiftX), maxShiftX)
                    let clampedYawShift = min(max(yawCorr * Double(cy), -maxShiftY), maxShiftY)

                    // Build transform: center → scale → rotate → translate → uncenter
                    let transform = CGAffineTransform.identity
                        .translatedBy(x: cx, y: cy)
                        .scaledBy(x: CGFloat(scale), y: CGFloat(scale))
                        .rotated(by: CGFloat(-clampedRoll))
                        .translatedBy(x: CGFloat(clampedPitchShift), y: CGFloat(clampedYawShift))
                        .translatedBy(x: -cx, y: -cy)

                    ciImage = ciImage.transformed(by: transform)

                    // Crop back to original size and reset origin to (0,0)
                    // Without the origin reset, CIContext.render offsets into the pixel buffer,
                    // leaving black strips on the right/bottom edges.
                    let cropRect = CGRect(
                        x: ciImage.extent.origin.x + (ciImage.extent.width - videoSize.width) / 2,
                        y: ciImage.extent.origin.y + (ciImage.extent.height - videoSize.height) / 2,
                        width: videoSize.width,
                        height: videoSize.height
                    )
                    ciImage = ciImage.cropped(to: cropRect)
                        .transformed(by: CGAffineTransform(translationX: -cropRect.origin.x, y: -cropRect.origin.y))

                    // Render to pixel buffer
                    if let pool = adaptor.pixelBufferPool {
                        var outputBuffer: CVPixelBuffer?
                        CVPixelBufferPoolCreatePixelBuffer(nil, pool, &outputBuffer)
                        if let outBuf = outputBuffer {
                            ciContext.render(ciImage, to: outBuf)
                            adaptor.append(outBuf, withPresentationTime: presentationTime)
                        }
                    }

                    frameCount += 1
                }
            }
        }

        // Process audio
        if let audioInput = audioWriterInput, let audioOutput = audioReaderOutput {
            let audioGroup = DispatchGroup()
            audioGroup.enter()

            audioInput.requestMediaDataWhenReady(on: DispatchQueue(label: "videoStabilizer.audio")) {
                while audioInput.isReadyForMoreMediaData {
                    guard let sampleBuffer = audioOutput.copyNextSampleBuffer() else {
                        audioInput.markAsFinished()
                        audioGroup.leave()
                        return
                    }
                    audioInput.append(sampleBuffer)
                }
            }
            audioGroup.wait()
        }

        videoGroup.wait()

        // Finish writing
        let semaphore = DispatchSemaphore(value: 0)
        writer.finishWriting {
            semaphore.signal()
        }
        semaphore.wait()

        let elapsed = Int64((CFAbsoluteTimeGetCurrent() - startTime) * 1000)
        NSLog("\(TAG): Stabilization complete: \(frameCount) frames in \(elapsed)ms")
        return elapsed
    }

    // MARK: - Color Pipeline Tuning Parameters

    // Tone curve anchor points (CIToneCurve: x = input, y = output)
    private static let toneCurvePoint0 = CIVector(x: 0.00, y: 0.05)
    private static let toneCurvePoint1 = CIVector(x: 0.25, y: 0.22)
    private static let toneCurvePoint2 = CIVector(x: 0.50, y: 0.50)
    private static let toneCurvePoint3 = CIVector(x: 0.75, y: 0.78)
    private static let toneCurvePoint4 = CIVector(x: 1.00, y: 0.95)

    // Vibrance: selective saturation boost (0.0 = off, 1.0 = max)
    private static let vibranceAmount: Double = 0.3

    // Color correction matrix (CIColorMatrix vectors)
    private static let rVector = CIVector(x: 1.06, y: 0.02, z: -0.01, w: 0)
    private static let gVector = CIVector(x: 0.01, y: 1.04, z: -0.01, w: 0)
    private static let bVector = CIVector(x: -0.02, y: 0.01, z: 1.02, w: 0)
    private static let aVector = CIVector(x: 0, y: 0, z: 0, w: 1)
    private static let biasVector = CIVector(x: 5.0 / 255.0, y: 3.0 / 255.0, z: 0, w: 0)

    // MARK: - Color Processing

    /// Apply S-curve tone mapping.
    private static func applyToneCurve(_ image: CIImage) -> CIImage {
        guard let filter = CIFilter(name: "CIToneCurve") else { return image }
        filter.setValue(image, forKey: kCIInputImageKey)
        filter.setValue(toneCurvePoint0, forKey: "inputPoint0")
        filter.setValue(toneCurvePoint1, forKey: "inputPoint1")
        filter.setValue(toneCurvePoint2, forKey: "inputPoint2")
        filter.setValue(toneCurvePoint3, forKey: "inputPoint3")
        filter.setValue(toneCurvePoint4, forKey: "inputPoint4")
        return filter.outputImage ?? image
    }

    /// Apply vibrance — selectively boosts undersaturated colors.
    private static func applyVibrance(_ image: CIImage) -> CIImage {
        guard let filter = CIFilter(name: "CIVibrance") else { return image }
        filter.setValue(image, forKey: kCIInputImageKey)
        filter.setValue(vibranceAmount, forKey: "inputAmount")
        return filter.outputImage ?? image
    }

    /// Apply color correction (warmth/white balance) via CIColorMatrix.
    private static func applyColorCorrection(_ image: CIImage) -> CIImage {
        guard let filter = CIFilter(name: "CIColorMatrix") else { return image }
        filter.setValue(image, forKey: kCIInputImageKey)
        filter.setValue(rVector, forKey: "inputRVector")
        filter.setValue(gVector, forKey: "inputGVector")
        filter.setValue(bVector, forKey: "inputBVector")
        filter.setValue(aVector, forKey: "inputAVector")
        filter.setValue(biasVector, forKey: "inputBiasVector")
        return filter.outputImage ?? image
    }

    // MARK: - Private Helpers

    private static func parseImuData(_ path: String) -> [ImuSample]? {
        guard let data = FileManager.default.contents(atPath: path),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let samples = json["samples"] as? [[Any]]
        else {
            return nil
        }

        return samples.compactMap { s -> ImuSample? in
            guard s.count >= 7 else { return nil }
            return ImuSample(
                timeMs: (s[0] as? NSNumber)?.doubleValue ?? 0,
                ax: (s[1] as? NSNumber)?.doubleValue ?? 0,
                ay: (s[2] as? NSNumber)?.doubleValue ?? 0,
                az: (s[3] as? NSNumber)?.doubleValue ?? 0,
                gx: (s[4] as? NSNumber)?.doubleValue ?? 0,
                gy: (s[5] as? NSNumber)?.doubleValue ?? 0,
                gz: (s[6] as? NSNumber)?.doubleValue ?? 0
            )
        }
    }

    private static func smoothEmaMultiPass(_ data: [Double]) -> [Double] {
        guard !data.isEmpty else { return data }
        var result = data
        for _ in 0 ..< SMOOTH_PASSES {
            var smooth = [Double](repeating: 0, count: result.count)
            smooth[0] = result[0]
            // Forward pass
            for i in 1 ..< result.count {
                smooth[i] = SMOOTH_FACTOR * smooth[i - 1] + (1 - SMOOTH_FACTOR) * result[i]
            }
            // Backward pass (zero-phase)
            for i in stride(from: result.count - 2, through: 0, by: -1) {
                smooth[i] = SMOOTH_FACTOR * smooth[i + 1] + (1 - SMOOTH_FACTOR) * smooth[i]
            }
            result = smooth
        }
        return result
    }
}
