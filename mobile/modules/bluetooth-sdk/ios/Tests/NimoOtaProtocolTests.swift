import Foundation
@testable import MentraBluetoothSDK
import XCTest

final class NimoOtaProtocolTests: XCTestCase {
    private func bytes(_ hex: String) -> Data {
        let chars = Array(hex)
        return Data(stride(from: 0, to: chars.count, by: 2).map { UInt8(String(chars[$0 ... $0 + 1]), radix: 16)! })
    }

    private func fixtures() throws -> [String: Any] {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("test-fixtures/nimo-ota.json"))) as? [String: Any])
    }

    func testCapturedRequestsAndResponsesAtEveryNotificationSplit() throws {
        let fixture = try fixtures()
        for item in try XCTUnwrap(fixture["requests"] as? [[String: Any]]) {
            XCTAssertEqual(try NimoOtaProtocol.request(UInt8(XCTUnwrap(item["command"] as? Int)), sequence: UInt8(XCTUnwrap(item["sequence"] as? Int)), params: bytes(XCTUnwrap(item["params"] as? String))), try bytes(XCTUnwrap(item["frame"] as? String)))
        }
        let responses = try XCTUnwrap(fixture["responses"] as? [[String: Any]])
        var combined = Data()
        for item in responses {
            let frame = try bytes(XCTUnwrap(item["frame"] as? String))
            combined += frame
            for split in 0 ... frame.count {
                let decoder = NimoOtaProtocol.Decoder()
                let actual = try decoder.feed(frame.prefix(split)) + decoder.feed(frame.dropFirst(split))
                XCTAssertEqual(actual.count, 1)
                XCTAssertEqual(Int(actual[0].command), item["command"] as? Int)
                XCTAssertEqual(Int(actual[0].sequence), item["sequence"] as? Int)
                XCTAssertEqual(Int(actual[0].status), item["status"] as? Int)
                XCTAssertEqual(actual[0].body, try bytes(XCTUnwrap(item["body"] as? String)))
            }
        }
        XCTAssertEqual(try NimoOtaProtocol.Decoder().feed(combined).count, responses.count)
    }

    func testSmallPhoneWritesUsePerChunkCrcAndRequestedOffset() throws {
        let fixture = try fixtures()
        let firmware = try bytes(XCTUnwrap(fixture["firmware"] as? String))
        for item in try XCTUnwrap(fixture["blocks"] as? [[String: Any]]) {
            let capacity = try XCTUnwrap(item["capacity"] as? Int)
            let parts = try NimoOtaProtocol.blockParts(firmware, slice: .init(offset: UInt64(XCTUnwrap(item["offset"] as? Int)), length: XCTUnwrap(item["length"] as? Int)), crc: XCTUnwrap(item["crc"] as? Bool), writeCapacity: capacity)
            XCTAssertEqual(parts, (item["parts"] as? [String])?.map(bytes))
            for (index, part) in parts.enumerated() {
                XCTAssertLessThanOrEqual(try NimoOtaProtocol.request(0xE5, sequence: UInt8(index), params: part).count, capacity)
            }
        }
        XCTAssertEqual(NimoOtaProtocol.crc32(Data("123456789".utf8)), 0xCBF4_3926)
    }

    func testRejectsMalformedFramesAndUnboundedDeviceRequests() throws {
        for hex in ["71", "70076ec0", "70076e00020001", "70076e00021001", "70076e0003000200fa00"] {
            XCTAssertThrowsError(try NimoOtaProtocol.Decoder().feed(bytes(hex)))
        }
        for hex in ["00", "0201", "01000100"] {
            XCTAssertThrowsError(try NimoOtaProtocol.deviceInfo(bytes(hex)))
        }
        for slice in [NimoOtaProtocol.Slice(offset: 100, length: 1), .init(offset: 0, length: 0), .init(offset: UInt64.max, length: Int.max)] {
            XCTAssertThrowsError(try NimoOtaProtocol.firmwareSlice(Data(count: 100), slice))
        }
        XCTAssertThrowsError(try NimoOtaProtocol.blockParts(Data(count: 100), slice: .init(offset: 0, length: 100), crc: true, writeCapacity: 20))
        XCTAssertThrowsError(try NimoOtaProtocol.enterResult(bytes("0100000012100001")))
        XCTAssertThrowsError(try NimoOtaProtocol.blockResult(bytes("000000000000007531")))
    }

    func testCapturedPreflightAndAuthoritativeBlockRequests() throws {
        let info = try NimoOtaProtocol.deviceInfo(bytes("0600000e000e0205010000020103026464020301020400020501"))
        XCTAssertEqual(info[1], bytes("00000201"))
        XCTAssertEqual(info[2], bytes("6464"))
        let entered = try NimoOtaProtocol.enterResult(bytes("0000000012100001"))
        XCTAssertEqual(entered.slice, .init(offset: 18, length: 4096))
        XCTAssertTrue(entered.crc)
        XCTAssertEqual(try NimoOtaProtocol.blockResult(bytes("000000101210000000")).slice, .init(offset: 4114, length: 4096))
        XCTAssertEqual(try NimoOtaProtocol.blockResult(Data(count: 9)).slice, .init(offset: 0, length: 0))
    }
}
