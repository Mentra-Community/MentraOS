import CoreGraphics
import Foundation
import ImageIO

/// Bounded image decoding independent of UIKit/AppKit and the Bluetooth actor.
enum NimoCanvasImage {
    static func source(_ input: String) throws -> CGImage {
        let data = try NimoCanvasCodec.imageBytes(input)
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let w = properties[kCGImagePropertyPixelWidth] as? Int,
              let h = properties[kCGImagePropertyPixelHeight] as? Int
        else {
            throw NimoCanvasCodec.Invalid.value("Invalid image")
        }
        try NimoCanvasCodec.require((1 ... 4096).contains(w) && (1 ... 4096).contains(h))
        try NimoCanvasCodec.require(w * h <= 4_000_000, "Decoded image exceeds limit")
        guard let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
            throw NimoCanvasCodec.Invalid.value("Image decode failed")
        }
        return image
    }

    static func decode(_ input: String, width: Int, height: Int) throws -> Data {
        try grayscale(source(input), width: width, height: height)
    }

    static func grayscale(_ image: CGImage, width: Int, height: Int) throws -> Data {
        try NimoCanvasCodec.region(0, 0, width, height)
        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                                      bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGBitmapInfo.byteOrder32Big.rawValue | CGImageAlphaInfo.premultipliedLast.rawValue)
        else {
            throw NimoCanvasCodec.Invalid.value("Image allocation failed")
        }
        context.setFillColor(red: 0, green: 0, blue: 0, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        context.interpolationQuality = .medium
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        guard let buffer = context.data?.assumingMemoryBound(to: UInt8.self) else {
            throw NimoCanvasCodec.Invalid.value("Image buffer unavailable")
        }
        var gray = Data(capacity: width * height)
        for y in 0 ..< height {
            for x in 0 ..< width {
                let offset = y * context.bytesPerRow + x * 4
                let luminance = (77 * Int(buffer[offset]) + 150 * Int(buffer[offset + 1]) + 29 * Int(buffer[offset + 2]) + 128) >> 8
                gray.append(UInt8(luminance))
            }
        }
        return gray
    }
}
