import CoreGraphics
import ImageIO
@testable import MentraBluetoothSDK
import UniformTypeIdentifiers
import XCTest

final class PhotoThumbnailTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    /// A `width`×`height` JPEG as the glasses' camera stores it, with an EXIF orientation.
    private func photo(width: Int, height: Int, orientation: Int = 1) throws -> URL {
        let context = try XCTUnwrap(CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        ))
        context.setFillColor(CGColor(red: 0.2, green: 0.5, blue: 0.8, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let image = try XCTUnwrap(context.makeImage())
        let url = directory.appendingPathComponent("p1.jpg")
        let destination = try XCTUnwrap(
            CGImageDestinationCreateWithURL(url as CFURL, UTType.jpeg.identifier as CFString, 1, nil)
        )
        CGImageDestinationAddImage(destination, image, [kCGImagePropertyOrientation: orientation] as CFDictionary)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        return url
    }

    func testTheLongSideIsScaledTo512AndTheThumbnailSitsBesideThePhoto() throws {
        let url = try photo(width: 3264, height: 2448)
        let thumbnail = try XCTUnwrap(PhotoThumbnails.make(url.absoluteString))
        XCTAssertEqual(thumbnail.width, 512)
        XCTAssertEqual(thumbnail.height, 384)
        XCTAssertEqual(thumbnail.mimeType, "image/jpeg")
        XCTAssertEqual(URL(string: thumbnail.url)?.lastPathComponent, "p1.thumb.jpg")
        XCTAssertGreaterThan(thumbnail.size, 0)
        XCTAssertTrue(FileManager.default.fileExists(atPath: directory.appendingPathComponent("p1.thumb.jpg").path))
    }

    func testTheEXIFOrientationIsApplied() throws {
        // Orientation 6: stored landscape, shown rotated 90° clockwise, so portrait.
        let url = try photo(width: 3264, height: 2448, orientation: 6)
        let thumbnail = try XCTUnwrap(PhotoThumbnails.make(url.path))
        XCTAssertEqual(thumbnail.width, 384)
        XCTAssertEqual(thumbnail.height, 512)
    }

    func testSomethingThatIsNotAPhotoHasNoThumbnail() throws {
        let url = directory.appendingPathComponent("p1.jpg")
        try Data("not a photo".utf8).write(to: url)
        XCTAssertNil(PhotoThumbnails.make(url.absoluteString))
        XCTAssertNil(PhotoThumbnails.make(directory.appendingPathComponent("missing.jpg").absoluteString))
    }
}
