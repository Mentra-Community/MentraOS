import Foundation

struct MentraLiveFileTransferSession {
    let fileName: String
    let fileSize: Int // NOTE: May be "fake" (inflated) due to BES firmware workaround
    let dynamicPayload: Bool
    var actualPackSize: Int = 0 // Actual pack size from first received packet
    var totalPackets: Int
    var expectedNextPacket: Int = 0
    var receivedPackets: [Int: Data] = [:]
    let startTime: Date
    var isComplete: Bool = false
    var isAnnounced: Bool = false

    /// BES2700 firmware hardcodes FILE_PACK_SIZE=400 when calculating totalPack.
    /// Android glasses "lie" about fileSize to make BES expect correct packet count.
    private static let BES_HARDCODED_PACK_SIZE = 400

    init(fileName: String, fileSize: Int, announcedPackets: Int? = nil, flags: UInt16 = 0) {
        self.fileName = fileName
        self.fileSize = fileSize
        dynamicPayload = (flags & 0x0002) != 0
        let computedPackets =
            (fileSize + K900ProtocolUtils.FILE_PACK_SIZE - 1) / K900ProtocolUtils.FILE_PACK_SIZE
        if let announced = announcedPackets, announced > 0 {
            totalPackets = announced
            isAnnounced = true
        } else {
            totalPackets = computedPackets
            isAnnounced = false
        }
        startTime = Date()
    }

    mutating func updateAnnouncedPackets(_ announced: Int) {
        guard announced > 0 else { return }
        totalPackets = announced
        isAnnounced = true
        if expectedNextPacket >= totalPackets {
            expectedNextPacket = min(expectedNextPacket, max(totalPackets - 1, 0))
        }
    }

    /// Recalculate total packets based on actual pack size from received packet.
    /// Dynamic headers carry the true byte count. Only legacy small packs use inflated sizes.
    mutating func recalculateTotalPackets(actualPackSize: Int) {
        guard actualPackSize > 0, actualPackSize <= K900ProtocolUtils.FILE_PACK_SIZE else { return }

        self.actualPackSize = actualPackSize

        // Detect BES lie: if fileSize is exact multiple of 400, glasses used the lie strategy
        let isBesLie = !dynamicPayload
            && (fileSize % Self.BES_HARDCODED_PACK_SIZE == 0)
            && (actualPackSize < Self.BES_HARDCODED_PACK_SIZE)

        let newTotalPackets: Int
        if isBesLie {
            // BES lie detected: totalPackets = fileSize / 400
            newTotalPackets = fileSize / Self.BES_HARDCODED_PACK_SIZE
            Bridge.log(
                "📦 BES Lie detected! fakeFileSize=\(fileSize), totalPackets=\(newTotalPackets), actualPackSize=\(actualPackSize)"
            )
        } else {
            // Normal case: calculate based on actual pack size
            newTotalPackets = (fileSize + actualPackSize - 1) / actualPackSize
        }

        if newTotalPackets != totalPackets {
            Bridge.log(
                "📦 Recalculating totalPackets: \(totalPackets) -> \(newTotalPackets) (packSize=\(actualPackSize), fileSize=\(fileSize))"
            )
            totalPackets = newTotalPackets
        }
    }

    mutating func addPacket(_ index: Int, data: Data) -> Bool {
        guard index >= 0 else { return false }

        // On first packet, recalculate total packets only when we do not already
        // have an authoritative pack size from protocol metadata.
        if receivedPackets.isEmpty && actualPackSize == 0 && !data.isEmpty {
            recalculateTotalPackets(actualPackSize: data.count)
        }

        guard index < totalPackets else { return false }
        if dynamicPayload {
            let expectedSize = min(actualPackSize, fileSize - index * actualPackSize)
            guard expectedSize > 0, data.count == expectedSize else { return false }
        }

        guard receivedPackets[index] == nil else {
            return false
        }

        receivedPackets[index] = data

        while receivedPackets[expectedNextPacket] != nil, expectedNextPacket < totalPackets {
            expectedNextPacket += 1
        }

        isComplete = (receivedPackets.count == totalPackets)
        return true
    }

    func isFinalPacket(_ index: Int) -> Bool {
        index == totalPackets - 1
    }

    func missingPacketIndices() -> [Int] {
        guard totalPackets > receivedPackets.count else { return [] }
        return (0 ..< totalPackets).compactMap { receivedPackets[$0] == nil ? $0 : nil }
    }

    /// Assemble file from received packets.
    /// NOTE: Calculates actual file size from received data, NOT from header fileSize,
    /// because fileSize may be "fake" (inflated) due to BES firmware workaround.
    func assembleFile() -> Data? {
        guard isComplete else { return nil }

        // Calculate actual file size by summing all received packet sizes
        let actualFileSize = receivedPackets.values.reduce(0) { $0 + $1.count }

        Bridge.log(
            "📦 Assembling file: headerFileSize=\(fileSize), actualFileSize=\(actualFileSize), totalPackets=\(totalPackets)"
        )

        var fileData = Data(capacity: actualFileSize)

        for i in 0 ..< totalPackets {
            if let packet = receivedPackets[i] {
                fileData.append(packet)
            }
        }

        return fileData
    }
}
