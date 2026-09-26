import Foundation

/// Serializes launch/update/exit. A business ACK means acceptance, not visible pixels.
final class NimoCanvasSession {
    enum Action: Equatable {
        case send(key: Int, frame: Data, ticket: UInt64)
        case reconnect(String)
        case rejected(Int)
    }

    private struct Flight {
        let key: Int
        let frame: Data
        let ticket: UInt64
    }

    private var ready = false
    private var active = false
    private var locked = false
    private var launchBlocked = false
    private var waitingReadiness = false
    private var observedNotReady = false
    private var readinessRetries = 0
    private var exitRequested = false
    private var desired: Data?
    private var accepted: Data?
    private var rejected: Data?
    private var scope: String?
    private var forceRevision: UInt64 = 0
    private var sentRevision: UInt64 = 0
    private var ticket: UInt64 = 0
    private var flight: Flight?

    func offer(_ frame: Data, scope: String, force: Bool = false) -> [Action] {
        if self.scope != scope || force { forceRevision &+= 1 }
        self.scope = scope
        desired = frame
        exitRequested = false
        return pump()
    }

    /// Only a fresh heartbeat samples both TWS and peer Companion readiness.
    func readiness(_ value: Bool, confirmed: Bool = false) -> [Action] {
        if !value { readinessRetries = 0 }
        if !value, flight != nil { return resetLink("Readiness lost during canvas command") }
        if waitingReadiness {
            if !value { observedNotReady = true }
            else if !observedNotReady {
                if !confirmed || readinessRetries >= 3 { return [] }
                readinessRetries += 1
            }
        }
        ready = value
        if !value { active = false; accepted = nil }
        if value { waitingReadiness = false }
        return pump()
    }

    /// Keep only the latest desired scene across a new transport generation.
    func disconnected() {
        ready = false; active = false; locked = false; launchBlocked = false
        waitingReadiness = false; observedNotReady = false; readinessRetries = 0
        accepted = nil; rejected = nil; flight = nil
        ticket &+= 1; forceRevision &+= 1
    }

    func exit() -> [Action] {
        desired = nil; scope = nil; accepted = nil; rejected = nil; exitRequested = true
        return pump()
    }

    func nativeApp(_ appId: Int, entered: Bool) -> [Action] {
        if (appId == NimoCanvasCodec.appId && !entered) || (appId != NimoCanvasCodec.appId && entered) {
            if flight?.key == 3 {
                active = false; accepted = nil
                if appId != NimoCanvasCodec.appId, entered { desired = nil; rejected = nil; scope = nil }
                return []
            }
            let ambiguous = flight != nil
            desired = nil; accepted = nil; rejected = nil; active = false; exitRequested = false; scope = nil
            if ambiguous { return resetLink("Native app transition interrupted canvas command") }
        }
        return []
    }

    func acceptsResponse(key: Int, payload: Data) -> Bool {
        guard let current = flight, current.key == key, let status = payload.first else { return false }
        let echo = key == 4 ? Data([0, 0xFD, 0, 0, 0]) : Data([0, 0xFD])
        if status == 0 { return payload == echo }
        return payload.count == 1 || (payload.count == echo.count && payload.dropFirst() == echo.dropFirst())
    }

    func response(key: Int, payload: Data) -> [Action] {
        guard acceptsResponse(key: key, payload: payload), let current = flight, let first = payload.first else { return [] }
        let status = Int(first)
        flight = nil
        if status != 0 {
            switch status {
            case 7:
                ready = false; waitingReadiness = true; observedNotReady = false; active = false; accepted = nil
            case 8:
                locked = true; active = false; accepted = nil
            case 2:
                return [.rejected(status)] + resetLink("Canvas device timeout is ambiguous")
            default:
                if key == 4 { rejected = current.frame }
                else {
                    if key == 1 { launchBlocked = true } else { desired = nil }
                    active = false; exitRequested = false
                }
            }
            return [.rejected(status)] + pump()
        }
        switch key {
        case 1: active = true
        case 4: accepted = current.frame; rejected = nil; readinessRetries = 0
        case 3: active = false; accepted = nil; exitRequested = false
        default: break
        }
        return pump()
    }

    func timeout(_ expectedTicket: UInt64) -> [Action] {
        guard flight?.ticket == expectedTicket else { return [] }
        return resetLink("Canvas ACK timeout; reconnect before reusing a command key")
    }

    private func resetLink(_ reason: String) -> [Action] {
        ready = false; active = false; accepted = nil; flight = nil
        ticket &+= 1; forceRevision &+= 1
        return [.reconnect(reason)]
    }

    private func pump() -> [Action] {
        guard ready, !locked, !launchBlocked, !waitingReadiness, flight == nil else { return [] }
        let key: Int
        if exitRequested, active { key = 3 }
        else if exitRequested { exitRequested = false; return [] }
        else if desired == nil { return [] }
        else if !active { key = 1 }
        else if desired == rejected { return [] }
        else if desired == accepted, sentRevision == forceRevision { return [] }
        else { key = 4 }
        let frame = key == 4 ? desired! : Data()
        if key == 4 { sentRevision = forceRevision }
        ticket &+= 1
        flight = Flight(key: key, frame: frame, ticket: ticket)
        return [.send(key: key, frame: frame, ticket: ticket)]
    }
}
