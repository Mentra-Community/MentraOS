#if os(macOS)
    import CoreGraphics
    import ImageIO
    @testable import MentraBluetoothSDK
    import UniformTypeIdentifiers
    import XCTest

    final class SdkImageTests: XCTestCase {
        func testInvalidImageIsRejected() {
            XCTAssertNil(SdkImage(data: Data("not an image".utf8)))
        }

        func testImageConvertsToJpegWithoutLosingDimensionsOrOrientation() throws {
            let context = try XCTUnwrap(CGContext(data: nil, width: 8, height: 4, bitsPerComponent: 8,
                                                  bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
            context.setFillColor(CGColor(red: 0, green: 1, blue: 0, alpha: 1))
            context.fill(CGRect(x: 0, y: 0, width: 8, height: 4))
            let image = try XCTUnwrap(context.makeImage())
            let data = NSMutableData()
            let destination = try XCTUnwrap(CGImageDestinationCreateWithData(data, UTType.tiff.identifier as CFString, 1, nil))
            CGImageDestinationAddImage(destination, image, [kCGImagePropertyOrientation: 6] as CFDictionary)
            XCTAssertTrue(CGImageDestinationFinalize(destination))

            let decoded = try XCTUnwrap(SdkImage(data: data as Data))
            XCTAssertEqual(decoded.size, CGSize(width: 8, height: 4))
            let jpeg = try XCTUnwrap(decoded.jpegData(compressionQuality: 0.8))
            let source = try XCTUnwrap(CGImageSourceCreateWithData(jpeg as CFData, nil))
            XCTAssertEqual(CGImageSourceGetType(source), UTType.jpeg.identifier as CFString)
            let properties = try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
            XCTAssertEqual(properties[kCGImagePropertyPixelWidth] as? Int, 8)
            XCTAssertEqual(properties[kCGImagePropertyPixelHeight] as? Int, 4)
            XCTAssertEqual(properties[kCGImagePropertyOrientation] as? Int, 6)
        }
    }
#endif
