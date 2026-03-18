import CoreImage
import UIKit

/// Image processor for gallery photos synced from Mentra glasses.
/// Applies lens distortion correction and color correction using CoreImage.
class ImageProcessor {
    private static let TAG = "ImageProcessor"

    // --- Lens distortion coefficients ---
    // Brown-Conrady model for the Mentra Live camera (Sony sensor, 118° FOV fisheye)
    // Calibrated from chessboard photos at 3264x2448 native sensor resolution.
    private static let k1: Double = -0.10
    private static let k2: Double = 0.02
    private static let p1: Double = 0.0
    private static let p2: Double = 0.0

    // --- Color pipeline tuning parameters ---

    // Tone curve anchor points (CIToneCurve: x = input, y = output)
    // Slight shadow lift for low-light camera, mild highlight compression, gentle S-curve.
    private static let toneCurvePoint0 = CIVector(x: 0.00, y: 0.05)
    private static let toneCurvePoint1 = CIVector(x: 0.25, y: 0.22)
    private static let toneCurvePoint2 = CIVector(x: 0.50, y: 0.50)
    private static let toneCurvePoint3 = CIVector(x: 0.75, y: 0.78)
    private static let toneCurvePoint4 = CIVector(x: 1.00, y: 0.95)

    // Vibrance: selective saturation boost for desaturated colors (0.0 = off, 1.0 = max)
    private static let vibranceAmount: Double = 0.3

    // Color correction matrix (CIColorMatrix vectors: [R, G, B, A])
    // Adjusts warmth/white balance to compensate for the glasses camera's color cast.
    private static let rVector = CIVector(x: 1.06, y: 0.02, z: -0.01, w: 0)
    private static let gVector = CIVector(x: 0.01, y: 1.04, z: -0.01, w: 0)
    private static let bVector = CIVector(x: -0.02, y: 0.01, z: 1.02, w: 0)
    private static let aVector = CIVector(x: 0, y: 0, z: 0, w: 1)
    private static let biasVector = CIVector(x: 5.0 / 255.0, y: 3.0 / 255.0, z: 0, w: 0)

    /// Process a gallery image with the specified corrections.
    /// - Parameters:
    ///   - inputPath: Path to the input JPEG file
    ///   - outputPath: Path to write the processed JPEG
    ///   - lensCorrection: Whether to apply barrel distortion correction
    ///   - colorCorrection: Whether to apply color/white balance correction
    /// - Returns: Processing time in milliseconds, or -1 on failure
    static func process(
        inputPath: String,
        outputPath: String,
        lensCorrection: Bool,
        colorCorrection: Bool
    ) -> Int64 {
        let startTime = CFAbsoluteTimeGetCurrent()

        guard let inputData = FileManager.default.contents(atPath: inputPath),
              let ciImage = CIImage(data: inputData)
        else {
            NSLog("\(TAG): Failed to load image: \(inputPath)")
            return -1
        }

        let w = ciImage.extent.width
        let h = ciImage.extent.height
        NSLog("\(TAG): Processing \(Int(w))x\(Int(h)) lens=\(lensCorrection) color=\(colorCorrection)")

        var image = ciImage

        // Step 1: Lens distortion correction
        if lensCorrection {
            image = applyLensCorrection(image)
        }

        // Step 2: Tone mapping — S-curve + vibrance
        if colorCorrection {
            image = applyToneCurve(image)
            image = applyVibrance(image)
        }

        // Step 3: Color correction — linear warmth/tint
        if colorCorrection {
            image = applyColorCorrection(image)
        }

        // Render to JPEG
        let context = CIContext(options: [.useSoftwareRenderer: false])
        let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!

        guard
            let jpegData = context.jpegRepresentation(
                of: image,
                colorSpace: colorSpace,
                options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.95]
            )
        else {
            NSLog("\(TAG): Failed to render JPEG")
            return -1
        }

        do {
            try jpegData.write(to: URL(fileURLWithPath: outputPath))
        } catch {
            NSLog("\(TAG): Failed to write output: \(error.localizedDescription)")
            return -1
        }

        let elapsed = Int64((CFAbsoluteTimeGetCurrent() - startTime) * 1000)
        NSLog("\(TAG): Processing complete in \(elapsed)ms -> \(outputPath)")
        return elapsed
    }

    /// Apply Brown-Conrady lens distortion correction using CIFilter.
    private static func applyLensCorrection(_ image: CIImage) -> CIImage {
        // Use a CIWarpKernel for the distortion model
        // The kernel maps output coordinates to input (distorted) coordinates
        let w = image.extent.width
        let h = image.extent.height
        let cx = w / 2.0
        let cy = h / 2.0
        let norm = sqrt(cx * cx + cy * cy)

        // Use vImage-style approach: render pixel-by-pixel via a custom CIKernel
        // For performance, we use the CGImage path with a bitmap context
        let context = CIContext(options: [.useSoftwareRenderer: false])
        guard let cgImage = context.createCGImage(image, from: image.extent) else {
            NSLog("\(TAG): Failed to create CGImage for lens correction")
            return image
        }

        let width = cgImage.width
        let height = cgImage.height
        let bytesPerPixel = 4
        let bytesPerRow = width * bytesPerPixel
        let totalBytes = height * bytesPerRow

        // Read source pixels
        guard
            let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
            let srcContext = CGContext(
                data: nil,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: bytesPerRow,
                space: colorSpace,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            )
        else {
            NSLog("\(TAG): Failed to create bitmap context")
            return image
        }

        srcContext.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
        guard let srcData = srcContext.data else { return image }
        let srcPixels = srcData.bindMemory(to: UInt8.self, capacity: totalBytes)

        // Create output context
        guard
            let dstContext = CGContext(
                data: nil,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: bytesPerRow,
                space: colorSpace,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            )
        else { return image }

        guard let dstData = dstContext.data else { return image }
        let dstPixels = dstData.bindMemory(to: UInt8.self, capacity: totalBytes)

        let cxI = Double(width) / 2.0
        let cyI = Double(height) / 2.0
        let normI = sqrt(cxI * cxI + cyI * cyI)

        // Remap each pixel with bilinear interpolation for sub-pixel accuracy
        let maxX = width - 2 // -2 because bilinear reads x0+1
        let maxY = height - 2

        for y in 0 ..< height {
            for x in 0 ..< width {
                let xn = (Double(x) - cxI) / normI
                let yn = (Double(y) - cyI) / normI
                let r2 = xn * xn + yn * yn
                let r4 = r2 * r2

                let radial = 1.0 + k1 * r2 + k2 * r4
                let xd = xn * radial + 2.0 * p1 * xn * yn + p2 * (r2 + 2.0 * xn * xn)
                let yd = yn * radial + p1 * (r2 + 2.0 * yn * yn) + 2.0 * p2 * xn * yn

                let srcXf = xd * normI + cxI
                let srcYf = yd * normI + cyI
                let x0 = Int(srcXf)
                let y0 = Int(srcYf)

                let dstIdx = (y * width + x) * bytesPerPixel
                if x0 < 0 || x0 > maxX || y0 < 0 || y0 > maxY {
                    // Out of bounds — black pixel
                    dstPixels[dstIdx] = 0
                    dstPixels[dstIdx + 1] = 0
                    dstPixels[dstIdx + 2] = 0
                    dstPixels[dstIdx + 3] = 255
                    continue
                }

                // Fractional parts for bilinear blend
                let fx = Float(srcXf - Double(x0))
                let fy = Float(srcYf - Double(y0))
                let ifx = 1.0 - fx
                let ify = 1.0 - fy

                // Four source pixels
                let idx00 = (y0 * width + x0) * bytesPerPixel
                let idx10 = idx00 + bytesPerPixel
                let idx01 = idx00 + bytesPerRow
                let idx11 = idx01 + bytesPerPixel

                // Bilinear blend per channel
                for c in 0 ..< 4 {
                    let v = ifx * ify * Float(srcPixels[idx00 + c])
                        + fx * ify * Float(srcPixels[idx10 + c])
                        + ifx * fy * Float(srcPixels[idx01 + c])
                        + fx * fy * Float(srcPixels[idx11 + c])
                    dstPixels[dstIdx + c] = UInt8(min(255, max(0, Int(v + 0.5))))
                }
            }
        }

        guard let outputCGImage = dstContext.makeImage() else { return image }
        return CIImage(cgImage: outputCGImage)
    }

    /// Apply S-curve tone mapping using CIToneCurve.
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

    /// Apply color correction using CIColorMatrix filter.
    private static func applyColorCorrection(_ image: CIImage) -> CIImage {
        guard let filter = CIFilter(name: "CIColorMatrix") else {
            NSLog("\(TAG): CIColorMatrix filter not available")
            return image
        }

        filter.setValue(image, forKey: kCIInputImageKey)
        filter.setValue(rVector, forKey: "inputRVector")
        filter.setValue(gVector, forKey: "inputGVector")
        filter.setValue(bVector, forKey: "inputBVector")
        filter.setValue(aVector, forKey: "inputAVector")
        filter.setValue(biasVector, forKey: "inputBiasVector")

        return filter.outputImage ?? image
    }

    /// Merge 3 exposure-bracketed images into a single HDR result using
    /// simple exposure fusion (Mertens' method approximation).
    /// - Parameters:
    ///   - underPath: Path to underexposed image (EV-2)
    ///   - normalPath: Path to normally exposed image (EV0)
    ///   - overPath: Path to overexposed image (EV+2)
    ///   - outputPath: Path to write the merged result
    /// - Returns: Processing time in ms, or -1 on failure
    static func mergeHdr(
        underPath: String, normalPath: String, overPath: String, outputPath: String
    ) -> Int64 {
        let startTime = CFAbsoluteTimeGetCurrent()

        guard let underData = FileManager.default.contents(atPath: underPath),
              let normalData = FileManager.default.contents(atPath: normalPath),
              let overData = FileManager.default.contents(atPath: overPath),
              let underImage = CIImage(data: underData),
              let normalImage = CIImage(data: normalData),
              let overImage = CIImage(data: overData)
        else {
            NSLog("\(TAG): Failed to load HDR bracket images")
            return -1
        }

        let context = CIContext(options: [.useSoftwareRenderer: false])
        let w = Int(normalImage.extent.width)
        let h = Int(normalImage.extent.height)

        // Render all three to CGImages for pixel access
        guard let underCG = context.createCGImage(underImage, from: underImage.extent),
              let normalCG = context.createCGImage(normalImage, from: normalImage.extent),
              let overCG = context.createCGImage(overImage, from: overImage.extent)
        else {
            NSLog("\(TAG): Failed to create CGImages for HDR merge")
            return -1
        }

        let bpp = 4
        let bytesPerRow = w * bpp
        let totalBytes = h * bytesPerRow
        guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) else { return -1 }
        let bitmapInfo = CGImageAlphaInfo.premultipliedLast.rawValue

        // Create contexts and read pixel data.
        // IMPORTANT: We must retain the CGContexts so their backing memory stays valid
        // while we access the pixel pointers.
        func makePixelContext(_ cgImage: CGImage) -> CGContext? {
            guard
                let ctx = CGContext(
                    data: nil, width: w, height: h, bitsPerComponent: 8,
                    bytesPerRow: bytesPerRow, space: colorSpace, bitmapInfo: bitmapInfo
                )
            else { return nil }
            ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: w, height: h))
            return ctx
        }

        guard let underCtx = makePixelContext(underCG),
              let normalCtx = makePixelContext(normalCG),
              let overCtx = makePixelContext(overCG),
              let uPx = underCtx.data?.bindMemory(to: UInt8.self, capacity: totalBytes),
              let nPx = normalCtx.data?.bindMemory(to: UInt8.self, capacity: totalBytes),
              let oPx = overCtx.data?.bindMemory(to: UInt8.self, capacity: totalBytes)
        else { return -1 }

        // Create output context
        guard
            let outCtx = CGContext(
                data: nil, width: w, height: h, bitsPerComponent: 8,
                bytesPerRow: bytesPerRow, space: colorSpace, bitmapInfo: bitmapInfo
            )
        else { return -1 }
        guard let outData = outCtx.data else { return -1 }
        let outPx = outData.bindMemory(to: UInt8.self, capacity: totalBytes)

        // Exposure fusion
        for i in stride(from: 0, to: totalBytes, by: bpp) {
            let uR = Float(uPx[i])
            let uG = Float(uPx[i + 1])
            let uB = Float(uPx[i + 2])
            let uLum = (uR + uG + uB) / 3.0 / 255.0
            let uW = 4.0 * uLum * (1.0 - uLum) + 0.01

            let nR = Float(nPx[i])
            let nG = Float(nPx[i + 1])
            let nB = Float(nPx[i + 2])
            let nLum = (nR + nG + nB) / 3.0 / 255.0
            let nW = 4.0 * nLum * (1.0 - nLum) + 0.01

            let oR = Float(oPx[i])
            let oG = Float(oPx[i + 1])
            let oB = Float(oPx[i + 2])
            let oLum = (oR + oG + oB) / 3.0 / 255.0
            let oW = 4.0 * oLum * (1.0 - oLum) + 0.01

            let total = uW + nW + oW
            outPx[i] = UInt8(min(255, (uR * uW + nR * nW + oR * oW) / total))
            outPx[i + 1] = UInt8(min(255, (uG * uW + nG * nW + oG * oW) / total))
            outPx[i + 2] = UInt8(min(255, (uB * uW + nB * nW + oB * oW) / total))
            outPx[i + 3] = 255
        }

        guard let outCGImage = outCtx.makeImage() else { return -1 }
        let resultImage = CIImage(cgImage: outCGImage)

        let resultColorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
        guard
            let jpegData = context.jpegRepresentation(
                of: resultImage, colorSpace: resultColorSpace,
                options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.95]
            )
        else { return -1 }

        do {
            try jpegData.write(to: URL(fileURLWithPath: outputPath))
        } catch {
            NSLog("\(TAG): Failed to write HDR result: \(error)")
            return -1
        }

        let elapsed = Int64((CFAbsoluteTimeGetCurrent() - startTime) * 1000)
        NSLog("\(TAG): HDR merge complete in \(elapsed)ms")
        return elapsed
    }
}
