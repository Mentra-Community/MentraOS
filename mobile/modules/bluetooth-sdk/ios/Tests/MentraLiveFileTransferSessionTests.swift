import Foundation
@testable import MentraBluetoothSDK
import XCTest

final class MentraLiveFileTransferSessionTests: XCTestCase {
    func testDynamicPayloadUsesTrueSizeEvenWhenDivisibleBy400() {
        for pack in [244, 474, 800] {
            var session = MentraLiveFileTransferSession(fileName: "photo", fileSize: 80000, flags: 2)
            session.recalculateTotalPackets(actualPackSize: pack)
            XCTAssertEqual(session.totalPackets, (80000 + pack - 1) / pack)
            for index in 0 ..< session.totalPackets {
                XCTAssertTrue(session.addPacket(index, data: Data(repeating: 7, count: min(pack, 80000 - index * pack))))
            }
            XCTAssertTrue(session.isComplete)
            XCTAssertEqual(session.assembleFile()?.count, 80000)
        }
    }

    func testLegacyInflatedSizeAndLargeUnflaggedPayloads() {
        // Old senders inflate the header length for small packs, including
        // the short final pack. Flag 1 only enables batched ACKs.
        for (pack, headerSize, actualSize, packets) in [(221, 80000, 43982, 200), (400, 80000, 79777, 200), (800, 80000, 80000, 100)] {
            var session = MentraLiveFileTransferSession(fileName: "photo", fileSize: headerSize, flags: 1)
            session.recalculateTotalPackets(actualPackSize: pack)
            XCTAssertEqual(session.totalPackets, packets)
            let source = Data((0 ..< actualSize).map { UInt8($0 % 251) })
            for index in (0 ..< packets).reversed() {
                let start = index * pack
                XCTAssertTrue(session.addPacket(index, data: source.subdata(in: start ..< min(start + pack, actualSize))))
            }
            XCTAssertTrue(session.isComplete)
            XCTAssertEqual(session.assembleFile(), source)
        }
    }

    func testMalformedOrDuplicatePacketsCannotCompleteFile() {
        var session = MentraLiveFileTransferSession(fileName: "photo", fileSize: 1000, flags: 2)
        session.recalculateTotalPackets(actualPackSize: 800)
        XCTAssertFalse(session.addPacket(0, data: Data(count: 799)))
        XCTAssertFalse(session.addPacket(2, data: Data(count: 200)))
        XCTAssertTrue(session.addPacket(1, data: Data(count: 200)))
        XCTAssertFalse(session.isComplete)
        XCTAssertFalse(session.addPacket(1, data: Data(count: 200)))
        XCTAssertTrue(session.addPacket(0, data: Data(count: 800)))
        XCTAssertEqual(session.assembleFile()?.count, 1000)
    }
}
