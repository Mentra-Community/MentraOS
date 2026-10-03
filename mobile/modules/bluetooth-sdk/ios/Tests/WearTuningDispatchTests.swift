@testable import MentraBluetoothSDK
import XCTest

/// Recording subclass used to prove wear methods dispatched through an
/// `SGCManager?` hit MentraLive, not the extension no-op.
@MainActor
private final class RecordingMentraLive: MentraLive {
    private(set) var calls: [String] = []

    override func queryWearState() {
        calls.append("queryWearState")
    }

    override func setWearReporting(_ enabled: Bool) {
        calls.append("setWearReporting:\(enabled)")
    }

    override func setWearTuning(intervalMs: Int, count: Int, majority: Int) {
        calls.append("setWearTuning:\(intervalMs),\(count),\(majority)")
    }

    override func requestWearTuning() {
        calls.append("requestWearTuning")
    }

    override func resetWearTuning() {
        calls.append("resetWearTuning")
    }
}

@MainActor
final class WearTuningDispatchTests: XCTestCase {
    func testWearMethodsDispatchThroughSGCManagerReference() {
        let live = RecordingMentraLive()
        let sgc: (any SGCManager)? = live

        sgc?.queryWearState()
        sgc?.setWearReporting(true)
        sgc?.setWearTuning(intervalMs: 300, count: 5, majority: 4)
        sgc?.requestWearTuning()
        sgc?.resetWearTuning()

        XCTAssertEqual(live.calls, [
            "queryWearState",
            "setWearReporting:true",
            "setWearTuning:300,5,4",
            "requestWearTuning",
            "resetWearTuning",
        ])
    }
}
