import CoreGraphics
import ImageIO
@testable import MentraBluetoothSDK
import UniformTypeIdentifiers
import XCTest

final class SdkImageTests: XCTestCase {
    func testInvalidImageIsRejected() {
        XCTAssertNil(SdkImage(data: Data("not an image".utf8)))
    }

    func testAllExifOrientationsProduceUprightPixelsAndJpegs() throws {
        // Six asymmetric tiles distinguish rotations from reflections.
        let pixels: [UInt8] = [10, 50, 90, 130, 170, 210]
        let raster = (0 ..< 32).flatMap { y in (0 ..< 48).map { x in pixels[(y / 16) * 3 + x / 16] } }
        let provider = try XCTUnwrap(CGDataProvider(data: Data(raster) as CFData))
        let image = try XCTUnwrap(CGImage(width: 48, height: 32, bitsPerComponent: 8, bitsPerPixel: 8,
                                          bytesPerRow: 48, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: [],
                                          provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent))
        let expected: [[UInt8]] = [
            [10, 50, 90, 130, 170, 210], [90, 50, 10, 210, 170, 130],
            [210, 170, 130, 90, 50, 10], [130, 170, 210, 10, 50, 90],
            [10, 130, 50, 170, 90, 210], [130, 10, 170, 50, 210, 90],
            [210, 90, 170, 50, 130, 10], [90, 210, 50, 170, 10, 130],
        ]
        for orientation in 1 ... 8 {
            let data = NSMutableData()
            let destination = try XCTUnwrap(CGImageDestinationCreateWithData(data, UTType.tiff.identifier as CFString, 1, nil))
            CGImageDestinationAddImage(destination, image, [kCGImagePropertyOrientation: orientation] as CFDictionary)
            XCTAssertTrue(CGImageDestinationFinalize(destination))

            let decoded = try XCTUnwrap(SdkImage(data: data as Data))
            let width = orientation < 5 ? 48 : 32
            let height = orientation < 5 ? 32 : 48
            XCTAssertEqual(decoded.size, CGSize(width: width, height: height))
            let context = try XCTUnwrap(CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                                                  bytesPerRow: width, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: 0))
            try context.draw(XCTUnwrap(decoded.cgImage), in: CGRect(x: 0, y: 0, width: width, height: height))
            let bytes = try XCTUnwrap(context.data).assumingMemoryBound(to: UInt8.self)
            let actual = stride(from: 8, to: height, by: 16).flatMap { y in
                stride(from: 8, to: width, by: 16).map { x in bytes[y * context.bytesPerRow + x] }
            }
            XCTAssertEqual(actual, expected[orientation - 1], "EXIF \(orientation)")

            let jpeg = try XCTUnwrap(decoded.jpegData(compressionQuality: 1))
            let source = try XCTUnwrap(CGImageSourceCreateWithData(jpeg as CFData, nil))
            let properties = try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
            XCTAssertEqual(CGImageSourceGetType(source), UTType.jpeg.identifier as CFString)
            XCTAssertEqual(properties[kCGImagePropertyOrientation] as? Int ?? 1, 1)
            XCTAssertEqual(try XCTUnwrap(SdkImage(data: jpeg)).size, decoded.size)
        }
    }
}
