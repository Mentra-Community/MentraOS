@testable import GlassesMediaCore
import XCTest

final class LocalNetworkAccessRequestTests: XCTestCase {
    private final class Connection: LocalNetworkAccessConnection {
        var onState: ((LocalNetworkAccessState) -> Void)?
        var starts = 0
        var cancellations = 0
        func start(queue _: DispatchQueue) {
            starts += 1
        }

        func cancel() {
            cancellations += 1
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
            connection.onState?(.permissionRequired)
            connection.onState?(.permissionRequired)
            XCTAssertEqual(prompts, 1)
            XCTAssertTrue(results.isEmpty, "A denied path may mean the user has not answered the alert yet")
            XCTAssertEqual(connection.cancellations, 0)
            connection.onState?(.ready)
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
        let late = queue.sync { () -> ((LocalNetworkAccessState) -> Void)? in
            connection.onState?(.permissionRequired)
            return connection.onState
        }
        request.cancel()
        try queue.sync {
            late?(.ready)
            XCTAssertEqual(results.count, 1)
            XCTAssertThrowsError(try results[0].get()) { XCTAssertTrue($0 is CancellationError) }
            XCTAssertEqual(connection.cancellations, 1)
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
            connection.onState?(.failed(NSError(domain: "network", code: 123)))
            XCTAssertEqual(prompts, 0)
            XCTAssertEqual(results.count, 1)
            XCTAssertThrowsError(try results[0].get()) { XCTAssertEqual(($0 as NSError).code, 123) }
        }
    }
}
