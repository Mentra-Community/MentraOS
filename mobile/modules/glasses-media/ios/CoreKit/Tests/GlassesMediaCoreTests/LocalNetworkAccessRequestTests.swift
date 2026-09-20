@testable import GlassesMediaCore
import Network
import XCTest

final class LocalNetworkAccessRequestTests: XCTestCase {
    private final class Connection: LocalNetworkAccessConnection {
        var onState: ((NWConnection.State, NWPath.UnsatisfiedReason?) -> Void)?
        var starts = 0
        var cancellations = 0
        func start(queue _: DispatchQueue) {
            starts += 1
        }

        func cancel() {
            cancellations += 1
        }
    }

    private final class Clock {
        var now: TimeInterval = 0
        private var tasks: [(deadline: TimeInterval, work: DispatchWorkItem)] = []

        func schedule(delay: TimeInterval, work: DispatchWorkItem) {
            tasks.append((now + delay, work))
        }

        func advance(_ seconds: TimeInterval) {
            now += seconds
            while let index = tasks.firstIndex(where: { $0.deadline <= now }) {
                tasks.remove(at: index).work.perform()
            }
        }
    }

    func testPermissionRequiredKeepsRequestPendingUntilAccessBecomesReady() throws {
        let queue = DispatchQueue(label: "test.permission")
        let connection = Connection()
        let request = LocalNetworkAccessRequest(connection: connection, queue: queue)
        var prompts = 0
        var results: [Result<Void, Error>] = []
        request.start(onPermissionRequired: { prompts += 1 }, completion: { results.append($0) })
        try queue.sync {
            connection.onState?(.waiting(.posix(.ENETDOWN)), .localNetworkDenied)
            connection.onState?(.waiting(.posix(.ENETDOWN)), .localNetworkDenied)
            XCTAssertEqual(prompts, 1)
            XCTAssertTrue(results.isEmpty, "A denied path may mean the user has not answered the alert yet")
            XCTAssertEqual(connection.cancellations, 0)
            connection.onState?(.ready, nil)
            XCTAssertEqual(results.count, 1)
            XCTAssertNoThrow(try results[0].get())
            XCTAssertEqual(connection.cancellations, 1)
        }
    }

    func testCancelWhileAlertIsOpenRejectsAndIgnoresLateApproval() throws {
        let queue = DispatchQueue(label: "test.permission.cancel")
        let connection = Connection()
        let request = LocalNetworkAccessRequest(connection: connection, queue: queue)
        var results: [Result<Void, Error>] = []
        request.start(onPermissionRequired: {}, completion: { results.append($0) })
        let late = queue.sync { () -> ((NWConnection.State, NWPath.UnsatisfiedReason?) -> Void)? in
            connection.onState?(.waiting(.posix(.ENETDOWN)), .localNetworkDenied)
            return connection.onState
        }
        request.cancel()
        try queue.sync {
            late?(.ready, nil)
            XCTAssertEqual(results.count, 1)
            XCTAssertThrowsError(try results[0].get()) { XCTAssertTrue($0 is CancellationError) }
            XCTAssertEqual(connection.cancellations, 1)
        }
    }

    func testTransientWaitingWithUnknownPathCanBecomeReady() throws {
        let queue = DispatchQueue(label: "test.permission.transient")
        let connection = Connection()
        let request = LocalNetworkAccessRequest(connection: connection, queue: queue)
        var results: [Result<Void, Error>] = []
        request.start(onPermissionRequired: {}, completion: { results.append($0) })
        try queue.sync {
            connection.onState?(.waiting(.posix(.ENETUNREACH)), nil)
            XCTAssertTrue(results.isEmpty, "NWConnection.waiting is not a terminal failure")
            XCTAssertEqual(connection.cancellations, 0)
            connection.onState?(.ready, nil)
            XCTAssertEqual(results.count, 1)
            XCTAssertNoThrow(try results[0].get())
        }
    }

    func testNetworkFailureIsNotMisclassifiedAsWaitingForPermission() throws {
        let queue = DispatchQueue(label: "test.permission.network")
        let connection = Connection()
        let request = LocalNetworkAccessRequest(connection: connection, queue: queue)
        var prompts = 0
        var results: [Result<Void, Error>] = []
        request.start(onPermissionRequired: { prompts += 1 }, completion: { results.append($0) })
        try queue.sync {
            connection.onState?(.failed(.posix(.ECONNREFUSED)), nil)
            XCTAssertEqual(prompts, 0)
            XCTAssertEqual(results.count, 1)
            XCTAssertThrowsError(try results[0].get()) { XCTAssertEqual($0 as? NWError, .posix(.ECONNREFUSED)) }
        }
    }

    func testRepeatedWaitingAndPreparingDoNotRestartConnectivityBudget() throws {
        let queue = DispatchQueue(label: "test.permission.timeout")
        let connection = Connection()
        let clock = Clock()
        let request = LocalNetworkAccessRequest(connection: connection, queue: queue,
                                                now: { clock.now }, scheduleTimeout: clock.schedule)
        var results: [Result<Void, Error>] = []
        request.start(onPermissionRequired: {}, completion: { results.append($0) })
        try queue.sync {
            connection.onState?(.setup, nil)
            clock.advance(10)
            connection.onState?(.waiting(.posix(.ENETUNREACH)), .notAvailable)
            clock.advance(10)
            connection.onState?(.preparing, nil)
            connection.onState?(.waiting(.posix(.ENETUNREACH)), nil)
            clock.advance(9)
            XCTAssertTrue(results.isEmpty)
            clock.advance(1)
            XCTAssertEqual(results.count, 1)
            XCTAssertThrowsError(try results[0].get()) {
                XCTAssertEqual($0.localizedDescription, "Local connection to the glasses timed out")
            }
            XCTAssertEqual(connection.cancellations, 1)
        }
    }

    func testPermissionTimeIsExcludedAndTheRemainingConnectivityBudgetResumes() throws {
        let queue = DispatchQueue(label: "test.permission.pause")
        let connection = Connection()
        let clock = Clock()
        let request = LocalNetworkAccessRequest(connection: connection, queue: queue,
                                                now: { clock.now }, scheduleTimeout: clock.schedule)
        var prompts = 0
        var results: [Result<Void, Error>] = []
        request.start(onPermissionRequired: { prompts += 1 }, completion: { results.append($0) })
        try queue.sync {
            connection.onState?(.waiting(.posix(.ENETDOWN)), nil)
            clock.advance(7)
            // Permission information can arrive after the initial nil-path waiting update.
            connection.onState?(.waiting(.posix(.ENETDOWN)), .localNetworkDenied)
            clock.advance(120)
            connection.onState?(.waiting(.posix(.ENETDOWN)), .localNetworkDenied)
            XCTAssertEqual(prompts, 1)
            XCTAssertTrue(results.isEmpty)
            XCTAssertEqual(connection.cancellations, 0)
            connection.onState?(.preparing, nil)
            clock.advance(10)
            connection.onState?(.waiting(.posix(.ENETDOWN)), .localNetworkDenied)
            clock.advance(80)
            XCTAssertTrue(results.isEmpty)
            XCTAssertEqual(prompts, 1)
            connection.onState?(.waiting(.posix(.ENETUNREACH)), .notAvailable)
            clock.advance(12)
            XCTAssertTrue(results.isEmpty)
            clock.advance(1)
            XCTAssertEqual(results.count, 1)
            XCTAssertThrowsError(try results[0].get()) {
                XCTAssertEqual($0.localizedDescription, "Local connection to the glasses timed out")
            }
        }
    }

    func testCancelDuringTransientWaitingIgnoresLateReadyAndTimeout() throws {
        let queue = DispatchQueue(label: "test.permission.transient.cancel")
        let connection = Connection()
        let clock = Clock()
        let request = LocalNetworkAccessRequest(connection: connection, queue: queue,
                                                now: { clock.now }, scheduleTimeout: clock.schedule)
        var results: [Result<Void, Error>] = []
        request.start(onPermissionRequired: {}, completion: { results.append($0) })
        let late = queue.sync {
            connection.onState?(.waiting(.posix(.ENETUNREACH)), nil)
            return connection.onState
        }
        request.cancel()
        try queue.sync {
            late?(.ready, nil)
            clock.advance(60)
            XCTAssertEqual(results.count, 1)
            XCTAssertThrowsError(try results[0].get()) { XCTAssertTrue($0 is CancellationError) }
            XCTAssertEqual(connection.cancellations, 1)
        }
    }

    func testNativeCancellationIsTerminal() throws {
        let queue = DispatchQueue(label: "test.permission.native.cancel")
        let connection = Connection()
        let request = LocalNetworkAccessRequest(connection: connection, queue: queue)
        var results: [Result<Void, Error>] = []
        request.start(onPermissionRequired: {}, completion: { results.append($0) })
        try queue.sync {
            connection.onState?(.cancelled, nil)
            XCTAssertEqual(results.count, 1)
            XCTAssertThrowsError(try results[0].get()) { XCTAssertTrue($0 is CancellationError) }
            XCTAssertEqual(connection.cancellations, 1)
        }
    }
}
