import CoreGraphics
import ImageIO
@testable import MentraBluetoothSDK
import XCTest
import zlib

final class NimoCanvasCodecTests: XCTestCase {
    private func hex(_ data: Data) -> String {
        data.map { String(format: "%02X", $0) }.joined()
    }

    private func packet(_ hex: String) -> Data {
        let chars = Array(hex)
        return Data(stride(from: 0, to: chars.count, by: 2).map { UInt8(String(chars[$0 ... $0 + 1]), radix: 16)! })
    }

    func testVendorGoldenPacketsMatchAndroid() throws {
        let frame = try NimoCanvasCodec.replace([
            NimoCanvasCodec.rectangle(20, 20, 120, 50, stroke: 2, radius: 8),
            NimoCanvasCodec.label("Hello Glass", 160, 30, 300, 40, font: 2),
        ])
        XCTAssertEqual(try hex(NimoCanvasCodec.frames(key: 4, content: frame, writeCapacity: 512)[0]),
                       "BF003600F72D000007043200FD000000020001010C0014001400780032000208FF00031900A0001E002C012800000002FF0B0048656C6C6F20476C617373")
        XCTAssertEqual(try hex(NimoCanvasCodec.frames(key: 1, writeCapacity: 512)[0]), "BF000600F5E4000007010200FD00")
        XCTAssertEqual(try hex(NimoCanvasCodec.frames(key: 3, writeCapacity: 512)[0]), "BF00050086E4000007030100FD")
    }

    func testPolarityOddPaddingAndImageHeader() throws {
        let gray = Data([0, 85, 170, 255, 255])
        XCTAssertEqual(try NimoCanvasCodec.pack2(gray), Data([0xE4, 0x3F]))
        let bitmap = try NimoCanvasCodec.bitmap(0, 0, 5, 1, gray: gray)
        XCTAssertEqual(bitmap.payload[10], 1)
        XCTAssertEqual(bitmap.payload[19], 2)
        XCTAssertEqual(bitmap.payload[20], 3)
        XCTAssertEqual(bitmap.payload[21], 2)
        XCTAssertEqual(bitmap.payload.dropFirst(29), Data([0x82, 0xE4, 0x3F]))
    }

    func testRleRunAndLiteralBoundariesRoundTrip() throws {
        for size in [1, 2, 3, 126, 127, 128, 254, 27500] {
            for source in [Data(repeating: 33, count: size), Data((0 ..< size).map { UInt8($0 % 251) })] {
                let encoded = try [UInt8](NimoCanvasCodec.rle(source))
                var decoded = Data(), i = 0
                while i < encoded.count {
                    let tag = encoded[i]; i += 1
                    let count = Int(tag & 127)
                    XCTAssertGreaterThan(count, 0)
                    if tag & 128 != 0 { decoded.append(contentsOf: encoded[i ..< i + count]); i += count }
                    else { decoded.append(Data(repeating: encoded[i], count: count)); i += 1 }
                }
                XCTAssertEqual(decoded, source)
            }
        }
    }

    func testZlibImageInflatesToPackedPixels() throws {
        let pixels: [UInt8] = (0 ..< 32768).map { index in
            let tone = ((index / 17) ^ (index / 43)) % 4
            return UInt8(tone * 85)
        }
        let gray = Data(pixels)
        let bitmap = try NimoCanvasCodec.bitmap(0, 0, 256, 128, gray: gray)
        XCTAssertEqual(bitmap.payload[20], 7)
        let compressed = Data(bitmap.payload.dropFirst(29))
        var count: uLong = 8192
        var output = Data(count: Int(count))
        let status = output.withUnsafeMutableBytes { dst in
            compressed.withUnsafeBytes { src in
                uncompress(dst.bindMemory(to: UInt8.self).baseAddress!, &count,
                           src.bindMemory(to: UInt8.self).baseAddress!, uLong(compressed.count))
            }
        }
        XCTAssertEqual(status, Z_OK)
        XCTAssertEqual(output, try NimoCanvasCodec.pack2(gray))
    }

    func testFragmentationRespectsCoreBluetoothCapacityAndCrc() throws {
        let content = try NimoCanvasCodec.replace([NimoCanvasCodec.label(String(repeating: "X", count: 2048), 0, 0, 500, 220)])
        var baseline: Data?
        for capacity in [20, 64, 185, 244, 512] {
            let frames = try NimoCanvasCodec.frames(key: 4, content: content, writeCapacity: capacity)
            var stream = Data()
            for (index, frame) in frames.enumerated() {
                XCTAssertLessThanOrEqual(frame.count, capacity)
                XCTAssertEqual(frame[1], 0)
                XCTAssertEqual(Int(frame[6]) | Int(frame[7]) << 8, index == frames.count - 1 ? 0 : index + 1)
                XCTAssertEqual(UInt16(frame[4]) | UInt16(frame[5]) << 8, nimoCrc16(Data(frame.dropFirst(8))))
                stream += frame.dropFirst(8)
            }
            if let baseline { XCTAssertEqual(stream, baseline) } else { baseline = stream }
        }
        XCTAssertThrowsError(try NimoCanvasCodec.frames(key: 4, content: content, writeCapacity: 19))
        XCTAssertThrowsError(try NimoCanvasCodec.frames(key: 4, content: Data(count: 12281), writeCapacity: 512))
    }

    func testStrictCanvasResponseParsing() {
        let good = packet("BF000900D87900000704050000FD000000")
        XCTAssertEqual(NimoCanvasCodec.response(good)?.payload, Data([0, 0xFD, 0, 0, 0]))
        XCTAssertNil(NimoCanvasCodec.response(good + Data([0])))
        for index in [0, 1, 2, 4, 6, 8, 10] {
            var bad = good; bad[index] ^= 1
            XCTAssertNil(NimoCanvasCodec.response(bad))
        }
        let body = Data([7, 4, 1, 0, 7])
        let statusOnly = NimoFrameCodec.transportHeader(body, needsAck: false) + body
        XCTAssertEqual(NimoCanvasCodec.response(statusOnly)?.payload, Data([7]))
    }

    func testUtf8RowsAndGeometryValidation() throws {
        XCTAssertEqual(try NimoCanvasCodec.label("😀é", 0, 0, 100, 20).textBytes, 6)
        XCTAssertThrowsError(try NimoCanvasCodec.label("a\0b", 0, 0, 100, 20))
        XCTAssertThrowsError(try NimoCanvasCodec.label(String(repeating: "é", count: 1025), 0, 0, 100, 20))
        let rows = try NimoCanvasCodec.textRows("first\n\nthird", 12, 15, 400, 100)
        XCTAssertEqual(rows.count, 2)
        XCTAssertEqual(rows.map { $0.payload[2] }, [15, 55])
        XCTAssertEqual(rows[1].payload[6], 20)
        XCTAssertThrowsError(try NimoCanvasCodec.rectangle(Int.max, 0, 10, 1))
        XCTAssertThrowsError(try NimoCanvasCodec.line(0, 0, 500, 219))
        XCTAssertThrowsError(try NimoCanvasCodec.circle(0, 10, radius: 10))
        XCTAssertEqual(try NimoCanvasCodec.circle(10, 10, radius: 10).payload.count, 9)
    }

    func testFrameBudgetsBeforeRasterDecode() throws {
        XCTAssertEqual(try NimoCanvasCodec.replace([]), Data([0, 0, 1]))
        let line = try NimoCanvasCodec.line(0, 0, 1, 1)
        XCTAssertThrowsError(try NimoCanvasCodec.replace(Array(repeating: line, count: 65)))
        let text = try NimoCanvasCodec.label(String(repeating: "a", count: 2048), 0, 0, 500, 220)
        XCTAssertThrowsError(try NimoCanvasCodec.replace(Array(repeating: text, count: 5)))
        let image = SceneElement(id: "image", type: "image", x: 0, y: 0, w: 500, h: 220, text: nil,
                                 data: "unused", border: 0, radius: 0, change: "unchanged", contentHash: "")
        var decoded = 0
        XCTAssertThrowsError(try NimoCanvasCodec.scene([image, image]) { _, _, _ in decoded += 1; return Data() })
        XCTAssertEqual(decoded, 0)
        XCTAssertThrowsError(try NimoCanvasCodec.replace([.init(type: 4, payload: Data(count: 12278))]))
    }

    func testWholeScenePreservesOrderAndIgnoresDiffAnnotations() throws {
        let text = SceneElement(id: "caption", type: "text", x: 10, y: 20, w: 100, h: 40, text: "hello",
                                data: nil, border: 2, radius: 3, change: "unchanged", contentHash: "")
        let expected = try NimoCanvasCodec.replace([
            NimoCanvasCodec.rectangle(10, 20, 100, 40, stroke: 2, radius: 3),
            NimoCanvasCodec.label("hello", 10, 20, 100, 20),
        ])
        XCTAssertEqual(try NimoCanvasCodec.scene([text]) { _, _, _ in XCTFail("Not an image"); return Data() }, expected)
    }

    func testImageKindAndDimensionsAreValidatedBeforeDecode() throws {
        let png = Data([0x89, 0x50, 0x4E, 0x47, 13, 10, 26, 10]) + Data(count: 24)
        XCTAssertEqual(try NimoCanvasCodec.imageBytes(png.base64EncodedString()), png)
        XCTAssertThrowsError(try NimoCanvasCodec.imageBytes("data:image/bmp;base64," + png.base64EncodedString()))
        XCTAssertThrowsError(try NimoCanvasCodec.imageBytes("data:image/jpeg;base64,AAAA"))
        XCTAssertThrowsError(try NimoCanvasCodec.imageBytes("Qk0"))
        XCTAssertThrowsError(try NimoCanvasImage.source(png.base64EncodedString()))
        XCTAssertThrowsError(try NimoCanvasCodec.imageBytes(String(repeating: "a", count: 2_800_001)))
    }

    func testJpegPixelsAreDecodedForRawAndDataUriInputs() throws {
        let rgba = Data(repeating: 255, count: 16)
        let provider = CGDataProvider(data: rgba as CFData)!
        let image = try XCTUnwrap(CGImage(width: 2, height: 2, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: 8,
                                          space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
                                          provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent))
        let bytes = NSMutableData()
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(bytes, "public.jpeg" as CFString, 1, nil))
        CGImageDestinationAddImage(destination, image, nil)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        let raw = (bytes as Data).base64EncodedString()
        for input in [raw, "data:image/jpeg;base64," + raw] {
            XCTAssertEqual(try NimoCanvasImage.decode(input, width: 2, height: 2), Data(repeating: 255, count: 4))
        }
        XCTAssertThrowsError(try NimoCanvasImage.source("data:image/png;base64," + raw))
    }

    func testRasterKeepsTopRowAndLuminanceWithoutInversion() throws {
        // Top row red/green; bottom row blue/white. Match the Android integer luminance formula.
        let rgba = Data([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255])
        let provider = CGDataProvider(data: rgba as CFData)!
        let image = try XCTUnwrap(CGImage(width: 2, height: 2, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: 8,
                                          space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.last.rawValue),
                                          provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent))
        XCTAssertEqual(try NimoCanvasImage.grayscale(image, width: 2, height: 2), Data([77, 149, 29, 255]))
    }
}
