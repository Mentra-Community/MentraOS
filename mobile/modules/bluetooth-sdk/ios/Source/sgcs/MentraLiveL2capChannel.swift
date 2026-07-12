import CoreBluetooth
import Foundation

/// Read-only LE L2CAP CoC fast path for Mentra Live file transfers.
///
/// BES sends the same K900 file frames over this channel that it otherwise
/// sends through the FILE_READ GATT characteristic. The stream is drained on
/// a dedicated thread so CoreBluetooth credits are returned independently of
/// React Native and main-thread work.
final class MentraLiveL2capChannel: NSObject, StreamDelegate {
    private static let readChunkSize = 4096
    private static let maxBufferSize = 64 * 1024
    private static let frameHeaderSize = 5
    private static let frameOverhead = 32
    private static let maxFilePayloadSize = K900ProtocolUtils.FILE_PACK_SIZE

    private let channel: CBL2CAPChannel
    private let onFileFrame: (Data) -> Void
    private let onClose: () -> Void
    private let stateLock = NSLock()

    private var receiveBuffer = [UInt8]()
    private var worker: Thread?
    private var closed = false
    private var closeNotified = false

    init(
        channel: CBL2CAPChannel,
        onFileFrame: @escaping (Data) -> Void,
        onClose: @escaping () -> Void
    ) {
        self.channel = channel
        self.onFileFrame = onFileFrame
        self.onClose = onClose
        super.init()
    }

    func start() {
        guard worker == nil else { return }
        let thread = Thread { [weak self] in
            self?.runReadLoop()
        }
        thread.name = "MentraLive-L2CAP"
        thread.qualityOfService = .userInitiated
        worker = thread
        thread.start()
    }

    func close() {
        stateLock.lock()
        let wasClosed = closed
        closed = true
        stateLock.unlock()

        guard !wasClosed else { return }
        channel.inputStream?.close()
        channel.outputStream?.close()
    }

    private var isClosed: Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        return closed
    }

    private func runReadLoop() {
        guard let input = channel.inputStream, let output = channel.outputStream else {
            notifyClosed()
            return
        }

        input.delegate = self
        input.schedule(in: .current, forMode: .default)
        output.schedule(in: .current, forMode: .default)
        input.open()
        output.open()

        while !isClosed {
            _ = RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.1))
        }

        input.close()
        output.close()
        input.remove(from: .current, forMode: .default)
        output.remove(from: .current, forMode: .default)
        input.delegate = nil
        notifyClosed()
    }

    func stream(_ aStream: Stream, handle eventCode: Stream.Event) {
        guard aStream === channel.inputStream else { return }

        switch eventCode {
        case .hasBytesAvailable:
            drainInput()
        case .endEncountered, .errorOccurred:
            close()
        default:
            break
        }
    }

    private func drainInput() {
        guard let input = channel.inputStream else { return }
        var chunk = [UInt8](repeating: 0, count: Self.readChunkSize)

        while input.hasBytesAvailable, !isClosed {
            let count = input.read(&chunk, maxLength: chunk.count)
            if count > 0 {
                appendAndDispatch(Array(chunk.prefix(count)))
            } else if count < 0 {
                close()
                return
            } else {
                break
            }
        }
    }

    private func appendAndDispatch(_ bytes: [UInt8]) {
        if receiveBuffer.count + bytes.count > Self.maxBufferSize {
            receiveBuffer.removeAll(keepingCapacity: true)
        }
        guard bytes.count <= Self.maxBufferSize else { return }
        receiveBuffer.append(contentsOf: bytes)

        while true {
            guard let start = startMarkerIndex() else {
                if receiveBuffer.last == 0x23 {
                    receiveBuffer = [0x23]
                } else {
                    receiveBuffer.removeAll(keepingCapacity: true)
                }
                return
            }

            if start > 0 {
                receiveBuffer.removeFirst(start)
            }
            guard receiveBuffer.count >= Self.frameHeaderSize else { return }

            let payloadSize = (Int(receiveBuffer[3]) << 8) | Int(receiveBuffer[4])
            guard payloadSize <= Self.maxFilePayloadSize else {
                receiveBuffer.removeFirst()
                continue
            }

            let frameSize = Self.frameOverhead + payloadSize
            guard receiveBuffer.count >= frameSize else { return }

            guard receiveBuffer[frameSize - 2] == 0x24,
                  receiveBuffer[frameSize - 1] == 0x24
            else {
                receiveBuffer.removeFirst()
                continue
            }

            onFileFrame(Data(receiveBuffer.prefix(frameSize)))
            receiveBuffer.removeFirst(frameSize)
        }
    }

    private func startMarkerIndex() -> Int? {
        guard receiveBuffer.count >= 2 else { return nil }
        for index in 0 ..< (receiveBuffer.count - 1)
            where receiveBuffer[index] == 0x23 && receiveBuffer[index + 1] == 0x23
        {
            return index
        }
        return nil
    }

    private func notifyClosed() {
        stateLock.lock()
        guard !closeNotified else {
            stateLock.unlock()
            return
        }
        closeNotified = true
        stateLock.unlock()
        onClose()
    }
}
