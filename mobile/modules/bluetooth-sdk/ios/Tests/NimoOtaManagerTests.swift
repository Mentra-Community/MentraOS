import CryptoKit
import Foundation
@testable import MentraBluetoothSDK
import XCTest

private func otaBytes(_ hex: String) -> Data {
    let chars = Array(hex)
    return Data(stride(from: 0, to: chars.count, by: 2).map { UInt8(String(chars[$0 ... $0 + 1]), radix: 16)! })
}

final class NimoOtaManagerTests: XCTestCase {
    private final class Harness {
        let firmware = Data((0 ..< 1024).map { UInt8($0 % 256) })
        var writes: [Data] = []
        var snapshots: [NimoOtaManager.Snapshot] = []
        var journals: [NimoOtaManager.Snapshot] = []
        var journalFails = false
        var holdWrite = false
        var readback: ((Result<NimoOtaManager.Inventory, Error>) -> Void)?
        var now: TimeInterval = 0
        var id = 0
        var timers: [Int: (TimeInterval, () -> Void)] = [:]
        let hashValid: Bool
        var target: NimoOtaManager.Target {
            .init(sha256: hashValid ? SHA256.hash(data: firmware).map { String(format: "%02x", $0) }.joined() : "invalid",
                  size: firmware.count, hardwareId: otaBytes("00000201"), firmwareDetail: "FW-VERSION-v0.1.1.1-approved",
                  packedVersion: "0.1.1.1", peerVersion: otaBytes("0001"))
        }

        lazy var manager = NimoOtaManager(firmware: firmware, target: target, writeCapacity: 512, connectionGeneration: 1, ports: .init(
            now: { [unowned self] in now },
            schedule: { [unowned self] delay, callback in
                id += 1; let token = id
                timers[token] = (now + delay, callback)
                return { [weak self] in self?.timers.removeValue(forKey: token) }
            },
            write: { [unowned self] data, completion in writes.append(data); if !holdWrite { completion(nil) } },
            readInventory: { [unowned self] callback in readback = callback },
            journal: { [unowned self] state in
                if journalFails { throw NimoOtaProtocol.ProtocolError(message: "Journal unavailable") }
                journals.append(state)
            },
            changed: { [unowned self] state in snapshots.append(state) }
        ))

        init(hashValid: Bool = true) {
            self.hashValid = hashValid
        }

        var command: UInt8 {
            writes.last![4]
        }

        func advance(_ seconds: TimeInterval) {
            let end = now + seconds
            while let next = timers.filter({ $0.value.0 <= end }).min(by: { a, b in a.value.0 == b.value.0 ? a.key < b.key : a.value.0 < b.value.0 }) {
                now = next.value.0; timers.removeValue(forKey: next.key); next.value.1()
            }
            now = end
        }

        func reply(_ body: Data, generation: Int = 1, status: UInt8 = 0) {
            let sent = writes.last!, length = body.count + 2
            let frame = Data([0x70, 7, 0x6E, 0, sent[4], UInt8(length >> 8), UInt8(length & 255), status, sent[7]]) + body + Data([0x33])
            manager.receive(frame, connectionGeneration: generation)
        }

        func info(_ peer: String = "000e000e") -> Data {
            otaBytes("0600\(peer)0205010000020103026464020301020400020501")
        }

        func preflight() {
            manager.start(); reply(info()); XCTAssertEqual(command, 0xE1)
            reply(otaBytes("000000000012")); XCTAssertEqual(command, 0xE2)
            reply(Data([3]))
        }

        func transfer() {
            preflight(); XCTAssertEqual(command, 0xE3)
            reply(otaBytes("0000000012038401")); advance(0.005)
            XCTAssertEqual(command, 0xE5)
            reply(Data(count: 9)); XCTAssertEqual(command, 0xE6)
            reply(Data([0])); XCTAssertEqual(command, 0xE8)
        }
    }

    func testVerifiesImageAndBothSidesBeforeResetAndRequiresActualReadback() {
        let h = Harness(); h.transfer()
        h.reply(Data([1])); XCTAssertFalse(h.writes.contains { $0[4] == 3 })
        h.advance(1); h.reply(Data([0]))
        XCTAssertEqual(h.command, 3); XCTAssertEqual(h.manager.snapshot.phase, "restarting")
        XCTAssertFalse(h.manager.snapshot.safeToRelease)
        h.manager.disconnected(connectionGeneration: 1)
        h.manager.reconnected(connectionGeneration: 2, writeCapacity: 244)
        XCTAssertEqual(h.manager.snapshot.phase, "verifying")
        h.readback?(.success(.init(firmwareDetail: h.target.firmwareDetail, packedVersion: h.target.packedVersion)))
        h.reply(h.info("00010001"), generation: 2)
        XCTAssertEqual(h.manager.snapshot.phase, "complete")
        XCTAssertTrue(h.manager.snapshot.safeToRelease)
        XCTAssertEqual(h.manager.snapshot.observedFirmware, h.target.firmwareDetail)
        XCTAssertEqual(h.journals.first?.phase, "preparing")
    }

    func testNoWriteOnHashFailureAndNoEntryWhenJournalFails() {
        let bad = Harness(hashValid: false); bad.manager.start()
        XCTAssertTrue(bad.writes.isEmpty); XCTAssertTrue(bad.manager.snapshot.safeToRelease)
        let h = Harness(); h.journalFails = true; h.preflight()
        XCTAssertEqual(h.manager.snapshot.phase, "failed"); XCTAssertTrue(h.manager.snapshot.safeToRelease)
        XCTAssertFalse(h.writes.contains { $0[4] == 0xE3 })
    }

    func testDuplicateStartAndOldConnectionResponsesCannotAdvanceOrRestart() {
        let h = Harness(); h.manager.start(); h.manager.start()
        XCTAssertEqual(h.writes.count, 1)
        h.reply(h.info(), generation: 0); XCTAssertEqual(h.writes.count, 1)
        h.advance(15); XCTAssertEqual(h.manager.snapshot.phase, "failed")
        XCTAssertTrue(h.manager.snapshot.safeToRelease)
    }

    func testEntryTimeoutAndTransferDisconnectKeepOwnershipWithoutReset() {
        let h = Harness(); h.preflight(); h.advance(15)
        XCTAssertEqual(h.manager.snapshot.phase, "interrupted"); XCTAssertFalse(h.manager.snapshot.safeToRelease)
        let count = h.writes.count
        h.manager.start(); h.manager.reconnected(connectionGeneration: 2, writeCapacity: 512); h.advance(200)
        XCTAssertEqual(h.writes.count, count)
        let during = Harness(); during.preflight(); during.reply(otaBytes("0000000012038401"))
        during.manager.disconnected(connectionGeneration: 1); during.advance(10)
        XCTAssertEqual(during.manager.snapshot.phase, "interrupted")
        XCTAssertFalse(during.writes.contains { $0[4] == 3 })
    }

    func testRejectedImageNeverReboots() {
        let h = Harness(); h.preflight(); h.reply(otaBytes("0000000012038401")); h.advance(0.005)
        h.reply(Data(count: 9)); h.reply(Data([1]))
        XCTAssertEqual(h.manager.snapshot.phase, "interrupted")
        XCTAssertFalse(h.writes.contains { $0[4] == 3 || $0[4] == 0xE8 })
    }

    func testSyncTimeoutBudgetCannotAuthorizeReset() {
        let h = Harness(); h.transfer(); h.advance(8 * 9)
        XCTAssertEqual(h.manager.snapshot.phase, "interrupted"); XCTAssertFalse(h.manager.snapshot.safeToRelease)
        XCTAssertEqual(h.writes.filter { $0[4] == 0xE8 }.count, 8)
        XCTAssertFalse(h.writes.contains { $0[4] == 3 })
    }

    func testSyncPendingAndFailureBudgetsAreSeparate() {
        let h = Harness(); h.transfer()
        for _ in 0 ..< 7 {
            h.reply(Data([2])); h.advance(1)
        }
        for _ in 0 ..< 179 {
            h.reply(Data([1])); h.advance(1)
        }
        XCTAssertEqual(h.manager.snapshot.phase, "synchronizing")
        h.reply(Data([1])); XCTAssertEqual(h.manager.snapshot.phase, "interrupted")
        XCTAssertFalse(h.writes.contains { $0[4] == 3 })
    }

    func testWrongReadbackAndPeerMismatchAreNotSuccess() {
        let wrong = Harness(); wrong.transfer(); wrong.reply(Data([0])); wrong.manager.reconnected(connectionGeneration: 2, writeCapacity: 512)
        wrong.readback?(.success(.init(firmwareDetail: "wrong", packedVersion: wrong.target.packedVersion)))
        XCTAssertEqual(wrong.manager.snapshot.phase, "interrupted")
        let peer = Harness(); peer.transfer(); peer.reply(Data([0])); peer.manager.reconnected(connectionGeneration: 2, writeCapacity: 512)
        peer.readback?(.success(.init(firmwareDetail: peer.target.firmwareDetail, packedVersion: peer.target.packedVersion)))
        peer.reply(peer.info("0001000e"), generation: 2)
        XCTAssertEqual(peer.manager.snapshot.phase, "interrupted"); XCTAssertFalse(peer.manager.snapshot.safeToRelease)
    }

    func testLateReconnectCanVerifyButNeverReflashAfterDeadline() {
        let h = Harness(); h.transfer(); h.reply(Data([0])); h.advance(180)
        XCTAssertEqual(h.manager.snapshot.phase, "interrupted")
        h.manager.reconnected(connectionGeneration: 2, writeCapacity: 512)
        XCTAssertEqual(h.manager.snapshot.phase, "verifying")
        h.readback?(.success(.init(firmwareDetail: h.target.firmwareDetail, packedVersion: h.target.packedVersion)))
        h.reply(h.info("00010001"), generation: 2)
        XCTAssertEqual(h.manager.snapshot.phase, "complete")
        XCTAssertEqual(h.writes.filter { $0[4] == 0xE3 }.count, 1)
        XCTAssertEqual(h.writes.filter { $0[4] == 3 }.count, 1)
    }

    func testInvalidRequestedSliceAndStalledQueueCannotContinue() {
        let bounds = Harness(); bounds.preflight(); bounds.reply(otaBytes("00ffffffffffff01"))
        XCTAssertEqual(bounds.manager.snapshot.phase, "interrupted")
        XCTAssertFalse(bounds.writes.contains { $0[4] == 0xE5 })
        let queue = Harness(); queue.preflight(); queue.holdWrite = true; queue.reply(otaBytes("0000000012038401"))
        queue.advance(30)
        XCTAssertEqual(queue.manager.snapshot.phase, "interrupted")
        XCTAssertEqual(queue.writes.filter { $0[4] == 0xE5 }.count, 1)
    }
}
