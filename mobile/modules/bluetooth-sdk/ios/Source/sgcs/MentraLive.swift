//
//  MentraLive.swift
//  AOS
//
//  Created by Matthew Fosse on 7/3/25.
//

//
// MentraLiveManager.swift
// MentraOS_Manager
//
// Converted from MentraLiveSGC.java
//

import Combine
import CoreBluetooth
import Foundation
import ImageIO
import UIKit

// MARK: - Supporting Types

struct MentraLiveDevice {
    let name: String
    let address: String
}

// MARK: - BlePhotoUploadService

class BlePhotoUploadService {
    static let TAG = "BlePhotoUploadService"

    /// Callback protocol
    protocol UploadCallback {
        func onSuccess(requestId: String)
        func onError(requestId: String, error: String)
    }

    enum PhotoUploadError: LocalizedError {
        case decodingFailed
        case avifNotSupported
        case uploadFailed(String)
        case invalidData

        var errorDescription: String? {
            switch self {
            case .decodingFailed:
                return "Failed to decode image data"
            case .avifNotSupported:
                return "AVIF format not supported on this iOS version"
            case let .uploadFailed(message):
                return "Upload failed: \(message)"
            case .invalidData:
                return "Invalid image data"
            }
        }
    }

    /**
     * Process image data and upload to webhook
     * - Parameters:
     *   - imageData: Raw image data (AVIF or JPEG)
     *   - requestId: Original request ID for tracking
     *   - webhookUrl: Destination webhook URL
     *   - authToken: Optional authentication token for upload
     *   - callback: Callback for success/error
     */
    static func processAndUploadPhoto(
        imageData: Data,
        requestId: String,
        webhookUrl: String,
        authToken: String?,
        onSuccess: ((String, String) -> Void)? = nil,
        onError: ((String, String) -> Void)? = nil
    ) {
        Task {
            do {
                Bridge.log(
                    "\(TAG): Processing BLE photo for upload. Image size: \(imageData.count) bytes"
                )

                let jpegData = try convertToJpegPreservingExif(imageData: imageData)
                Bridge.log("\(TAG): Converted to JPEG for upload. Size: \(jpegData.count) bytes")

                // Upload to webhook
                let responseBody = try await uploadToWebhook(
                    jpegData: jpegData,
                    requestId: requestId,
                    webhookUrl: webhookUrl,
                    authToken: authToken
                )

                Bridge.log("\(TAG): Photo uploaded successfully for requestId: \(requestId)")
                onSuccess?(requestId, responseBody)

            } catch {
                Bridge.log(
                    "\(TAG): Error processing BLE photo for requestId: \(requestId), error: \(error)"
                )
                onError?(requestId, error.localizedDescription)
            }
        }
    }

    private static func convertToJpegPreservingExif(imageData: Data) throws -> Data {
        logIncomingImageDiagnostics(imageData: imageData)
        let imuJson = readImuJsonFromImageData(imageData)

        guard let image = decodeImage(imageData: imageData) else {
            throw NSError(
                domain: "BlePhotoUpload",
                code: -1,
                userInfo: [NSLocalizedDescriptionKey: "Failed to decode image data"]
            )
        }

        Bridge.log(
            "\(TAG): Decoded image to bitmap: \(Int(image.size.width))x\(Int(image.size.height))"
        )

        guard var jpegData = image.jpegData(compressionQuality: 0.9) else {
            throw NSError(
                domain: "BlePhotoUpload",
                code: -2,
                userInfo: [NSLocalizedDescriptionKey: "Failed to convert image to JPEG"]
            )
        }

        if let imuJson, !imuJson.isEmpty {
            jpegData = try writeImuJsonToJpegData(jpegData, imuJson: imuJson)
            Bridge.log("\(TAG): Re-attached IMU EXIF UserComment on output JPEG (\(imuJson.count) chars)")
        } else {
            let rawHasExif = containsExifMarker(in: imageData)
            Bridge.log(
                "\(TAG): No IMU from ImageIO (container=\(describeContainer(imageData)), rawHasExifMarker=\(rawHasExif))"
            )
        }

        return jpegData
    }

    private static func logIncomingImageDiagnostics(imageData: Data) {
        Bridge.log(
            "\(TAG): BLE image diagnostics: size=\(imageData.count) bytes, container=\(describeContainer(imageData)), rawHasExifMarker=\(containsExifMarker(in: imageData))"
        )
    }

    private static func describeContainer(_ data: Data) -> String {
        let bytes = [UInt8](data.prefix(12))
        if bytes.count >= 2, bytes[0] == 0xFF, bytes[1] == 0xD8 { return "jpeg" }
        if bytes.count >= 12, bytes[4] == 0x66, bytes[5] == 0x74, bytes[6] == 0x79, bytes[7] == 0x70 {
            let brand = String(bytes: bytes[8..<12], encoding: .ascii) ?? "?"
            return "iso_bmff/ftyp=\(brand)"
        }
        return "unknown"
    }

    private static func containsExifMarker(in data: Data) -> Bool {
        let marker: [UInt8] = [0x45, 0x78, 0x69, 0x66, 0, 0]
        let bytes = [UInt8](data)
        guard bytes.count >= marker.count else { return false }
        for i in 0...(bytes.count - marker.count) {
            if Array(bytes[i..<(i + marker.count)]) == marker { return true }
        }
        return false
    }

    private static func readImuJsonFromImageData(_ imageData: Data) -> String? {
        // Primary: ImageIO EXIF (works for JPEG and well-formed AVIF)
        if let source = CGImageSourceCreateWithData(imageData as CFData, nil),
            let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any]
        {
            let exif = properties[kCGImagePropertyExifDictionary as String] as? [String: Any]
            let userComment = exif?[kCGImagePropertyExifUserComment as String] as? String
            let tiff = properties[kCGImagePropertyTIFFDictionary as String] as? [String: Any]
            let description = tiff?[kCGImagePropertyTIFFImageDescription as String] as? String
            Bridge.log(
                "\(TAG): ImageIO EXIF UserComment=\(describeExifAttribute(userComment)), ImageDescription=\(describeExifAttribute(description))"
            )
            if let userComment, !userComment.isEmpty { return userComment }
            if let description, !description.isEmpty { return description }
        } else {
            Bridge.log("\(TAG): ImageIO: could not read properties")
        }

        // Fallback: raw TIFF scan for AVIFs where ImageIO doesn't expose the embedded Exif block
        if containsExifMarker(in: imageData) {
            if let tiffResult = readImuJsonFromTiff(imageData) {
                Bridge.log("\(TAG): Read IMU UserComment via TIFF scan (\(tiffResult.count) chars)")
                return tiffResult
            }
        }
        return nil
    }

    /// Scans raw bytes for the {@code Exif\0\0} TIFF header and reads UserComment (0x9286).
    private static func readImuJsonFromTiff(_ data: Data) -> String? {
        let bytes = [UInt8](data)
        let marker: [UInt8] = [0x45, 0x78, 0x69, 0x66, 0, 0]
        var searchFrom = 0
        while searchFrom <= bytes.count - marker.count {
            guard let exifOff = findBytes(marker, in: bytes, from: searchFrom) else { break }
            let tiff = exifOff + 6
            guard tiff + 8 <= bytes.count else { break }
            let littleEndian = bytes[tiff] == 0x49 && bytes[tiff + 1] == 0x49
            let bigEndian = bytes[tiff] == 0x4D && bytes[tiff + 1] == 0x4D
            guard littleEndian || bigEndian else { searchFrom = exifOff + 1; continue }
            let magic = readU16(bytes, at: tiff + 2, le: littleEndian)
            guard magic == 0x002A else { searchFrom = exifOff + 1; continue }
            let ifd0Off = Int(readU32(bytes, at: tiff + 4, le: littleEndian))
            if let result = readTagFromIfd(
                bytes, tiff: tiff, ifdOff: tiff + ifd0Off, tag: 0x9286, le: littleEndian)
            {
                return result
            }
            searchFrom = exifOff + 1
        }
        return nil
    }

    private static func readTagFromIfd(
        _ bytes: [UInt8], tiff: Int, ifdOff: Int, tag: UInt16, le: Bool
    ) -> String? {
        guard ifdOff + 2 <= bytes.count else { return nil }
        let count = Int(readU16(bytes, at: ifdOff, le: le))
        var off = ifdOff + 2
        for _ in 0..<count {
            guard off + 12 <= bytes.count else { break }
            let entryTag = readU16(bytes, at: off, le: le)
            let type = readU16(bytes, at: off + 2, le: le)
            let valueCount = Int(readU32(bytes, at: off + 4, le: le))
            if entryTag == tag {
                let byteLen = valueCount
                let valueOff: Int
                if byteLen > 4 {
                    valueOff = tiff + Int(readU32(bytes, at: off + 8, le: le))
                } else {
                    valueOff = off + 8
                }
                // UserComment starts with 8-byte charset prefix
                let startOff = (tag == 0x9286 && byteLen > 8) ? valueOff + 8 : valueOff
                let len = (tag == 0x9286 && byteLen > 8) ? byteLen - 8 : byteLen
                guard startOff + len <= bytes.count else { return nil }
                return String(bytes: Array(bytes[startOff..<startOff + len]), encoding: .utf8)?
                    .trimmingCharacters(in: .init(charactersIn: "\0"))
            }
            // Follow Exif IFD pointer
            if entryTag == 0x8769, type == 4 {
                let subOff = tiff + Int(readU32(bytes, at: off + 8, le: le))
                if let r = readTagFromIfd(bytes, tiff: tiff, ifdOff: subOff, tag: tag, le: le) {
                    return r
                }
            }
            off += 12
        }
        return nil
    }

    private static func findBytes(_ needle: [UInt8], in haystack: [UInt8], from: Int) -> Int? {
        guard haystack.count >= needle.count else { return nil }
        for i in from...(haystack.count - needle.count) {
            if Array(haystack[i..<i + needle.count]) == needle { return i }
        }
        return nil
    }

    private static func readU16(_ bytes: [UInt8], at off: Int, le: Bool) -> UInt16 {
        let a = UInt16(bytes[off]), b = UInt16(bytes[off + 1])
        return le ? a | (b << 8) : (a << 8) | b
    }

    private static func readU32(_ bytes: [UInt8], at off: Int, le: Bool) -> UInt32 {
        let a = UInt32(bytes[off]), b = UInt32(bytes[off + 1]),
            c = UInt32(bytes[off + 2]), d = UInt32(bytes[off + 3])
        return le ? a | (b << 8) | (c << 16) | (d << 24) : (a << 24) | (b << 16) | (c << 8) | d
    }

    private static func describeExifAttribute(_ value: String?) -> String {
        guard let value else { return "null" }
        if value.isEmpty { return "empty" }
        let preview = value.count > 80 ? String(value.prefix(80)) + "…" : value
        return "len=\(value.count) preview=\"\(preview)\""
    }

    private static func writeImuJsonToJpegData(_ jpegData: Data, imuJson: String) throws -> Data {
        guard let source = CGImageSourceCreateWithData(jpegData as CFData, nil),
            let imageType = CGImageSourceGetType(source),
            let cgImage = CGImageSourceCreateImageAtIndex(source, 0, nil)
        else {
            throw PhotoUploadError.decodingFailed
        }

        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            output, imageType, 1, nil
        ) else {
            throw PhotoUploadError.decodingFailed
        }

        var properties =
            (CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any]) ?? [:]
        var exif =
            (properties[kCGImagePropertyExifDictionary as String] as? [String: Any]) ?? [:]
        exif[kCGImagePropertyExifUserComment as String] = imuJson
        properties[kCGImagePropertyExifDictionary as String] = exif

        CGImageDestinationAddImage(destination, cgImage, properties as CFDictionary)
        guard CGImageDestinationFinalize(destination) else {
            throw PhotoUploadError.decodingFailed
        }
        return output as Data
    }

    /**
     * Decode image data (AVIF or JPEG) to UIImage.
     * AVIF arriving from glasses has a TIFF EXIF block appended to {@code mdat}; iOS ImageIO
     * rejects those bytes the same way Android does. Strip the Exif tail before decoding.
     */
    private static func decodeImage(imageData: Data) -> UIImage? {
        let isAvif = isAvifData(imageData)
        var decodeData = imageData
        if isAvif && containsExifMarker(in: imageData) {
            let stripped = stripAvifExifTail(imageData)
            if stripped.count < imageData.count {
                Bridge.log(
                    "\(TAG): Stripped Exif metadata item for decode: \(imageData.count) -> \(stripped.count) bytes"
                )
                decodeData = stripped
            }
        }

        if let image = UIImage(data: decodeData) {
            return image
        }

        if isAvif {
            if #available(iOS 16.0, *) {
                return UIImage(data: decodeData)
            } else {
                Bridge.log("\(TAG): AVIF decoding not supported on iOS < 16")
                return nil
            }
        }
        return nil
    }

    private static func isAvifData(_ data: Data) -> Bool {
        let bytes = [UInt8](data.prefix(12))
        return bytes.count >= 12
            && bytes[4] == 0x66 && bytes[5] == 0x74 && bytes[6] == 0x79 && bytes[7] == 0x70
            && bytes[8] == 0x61 && bytes[9] == 0x76 && bytes[10] == 0x69 && bytes[11] == 0x66
    }

    /// Truncates the {@code mdat} box at the {@code Exif\0\0} marker, removing the TIFF EXIF
    /// block that the glasses encoder appends. Returns original data unchanged on any parse error.
    private static func stripAvifExifTail(_ data: Data) -> Data {
        let bytes = [UInt8](data)
        let marker: [UInt8] = [0x45, 0x78, 0x69, 0x66, 0, 0]

        // Find last Exif marker
        var lastExif = -1
        for i in 0...(bytes.count - marker.count) {
            if Array(bytes[i..<i + marker.count]) == marker { lastExif = i }
        }
        guard lastExif >= 0 else { return data }

        // Walk top-level boxes to find mdat
        var off = 0
        while off + 8 <= bytes.count {
            let boxSize = Int(readU32BE(bytes, at: off))
            guard boxSize >= 8, off + boxSize <= bytes.count else { break }
            let boxType = String(bytes: Array(bytes[off + 4..<off + 8]), encoding: .ascii) ?? ""
            if boxType == "mdat" {
                let payloadStart = off + 8
                let payloadEnd = off + boxSize
                guard lastExif >= payloadStart, lastExif < payloadEnd else { break }
                let newPayloadLen = lastExif - payloadStart
                guard newPayloadLen > 0 else { break }

                var result = Data()
                // Everything up to mdat header
                result.append(contentsOf: bytes[0..<off])
                // New mdat box header with updated size
                let newMdatSize = UInt32(8 + newPayloadLen)
                result.append(UInt8((newMdatSize >> 24) & 0xFF))
                result.append(UInt8((newMdatSize >> 16) & 0xFF))
                result.append(UInt8((newMdatSize >> 8) & 0xFF))
                result.append(UInt8(newMdatSize & 0xFF))
                result.append(contentsOf: [0x6D, 0x64, 0x61, 0x74]) // "mdat"
                result.append(contentsOf: bytes[payloadStart..<payloadStart + newPayloadLen])
                return result
            }
            off += boxSize
        }
        return data
    }

    private static func readU32BE(_ bytes: [UInt8], at off: Int) -> UInt32 {
        UInt32(bytes[off]) << 24 | UInt32(bytes[off + 1]) << 16
            | UInt32(bytes[off + 2]) << 8 | UInt32(bytes[off + 3])
    }

    private static func uploadToWebhook(
        jpegData: Data,
        requestId: String,
        webhookUrl: String,
        authToken: String?
    ) async throws -> String {
        guard let url = URL(string: webhookUrl) else {
            Bridge.log("LIVE: Invalid webhook URL: \(webhookUrl)")
            throw PhotoUploadError.uploadFailed("Invalid webhook URL")
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 30

        // Add auth header if provided
        if let authToken, !authToken.isEmpty {
            request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        }

        // Create multipart form data
        let boundary = UUID().uuidString
        request.setValue(
            "multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type"
        )

        var body = Data()

        // Add requestId field
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append(
            "Content-Disposition: form-data; name=\"requestId\"\r\n\r\n".data(using: .utf8)!
        )
        body.append("\(requestId)\r\n".data(using: .utf8)!)

        // Add source field
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"source\"\r\n\r\n".data(using: .utf8)!)
        body.append("ble_transfer\r\n".data(using: .utf8)!)

        // Add photo field
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append(
            "Content-Disposition: form-data; name=\"photo\"; filename=\"\(requestId).jpg\"\r\n"
                .data(using: .utf8)!
        )
        body.append("Content-Type: image/jpeg\r\n\r\n".data(using: .utf8)!)
        body.append(jpegData)
        body.append("\r\n".data(using: .utf8)!)

        // Close multipart form
        body.append("--\(boundary)--\r\n".data(using: .utf8)!)

        request.httpBody = body

        print("LIVE: Uploading photo to webhook: \(webhookUrl)")

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            guard let httpResponse = response as? HTTPURLResponse else {
                throw PhotoUploadError.uploadFailed("Invalid response")
            }

            if httpResponse.statusCode < 200 || httpResponse.statusCode >= 300 {
                let errorBody = String(data: data, encoding: .utf8) ?? "No response body"
                throw PhotoUploadError.uploadFailed(
                    "Upload failed with code \(httpResponse.statusCode): \(errorBody)"
                )
            }

            print("LIVE: Upload successful. Response code: \(httpResponse.statusCode)")
            return String(data: data, encoding: .utf8) ?? ""

        } catch {
            if error is PhotoUploadError {
                throw error
            } else {
                throw PhotoUploadError.uploadFailed(error.localizedDescription)
            }
        }
    }
}

extension Data {
    mutating func append(_ string: String) {
        if let data = string.data(using: .utf8) {
            append(data)
        }
    }
}

private enum K900ProtocolUtils {
    // Protocol constants
    static let CMD_START_CODE: [UInt8] = [0x23, 0x23] // ##
    static let CMD_END_CODE: [UInt8] = [0x24, 0x24] // $$
    static let CMD_TYPE_STRING: UInt8 = 0x30 // String/JSON type

    // JSON Field constants
    static let FIELD_C = "C" // Command/Content field
    static let FIELD_V = "V" // Version field
    static let FIELD_B = "B" // Body field

    // Command types
    static let CMD_TYPE_PHOTO: UInt8 = 0x31
    static let CMD_TYPE_VIDEO: UInt8 = 0x32
    static let CMD_TYPE_MUSIC: UInt8 = 0x33
    static let CMD_TYPE_AUDIO: UInt8 = 0x34
    static let CMD_TYPE_DATA: UInt8 = 0x35

    // File transfer constants
    static let FILE_PACK_SIZE = 400 // Max data size per packet
    static let LENGTH_FILE_START = 2
    static let LENGTH_FILE_TYPE = 1
    static let LENGTH_FILE_PACKSIZE = 2
    static let LENGTH_FILE_PACKINDEX = 2
    static let LENGTH_FILE_SIZE = 4
    static let LENGTH_FILE_NAME = 16
    static let LENGTH_FILE_FLAG = 2
    static let LENGTH_FILE_VERIFY = 1
    static let LENGTH_FILE_END = 2

    struct FilePacketInfo {
        var fileType: UInt8 = 0
        var packSize: UInt16 = 0
        var packIndex: UInt16 = 0
        var fileSize: UInt32 = 0
        var fileName: String = ""
        var flags: UInt16 = 0
        var data: Data = .init()
        var verifyCode: UInt8 = 0
        var isValid: Bool = false
    }

    static func extractFilePacket(_ protocolData: Data) -> FilePacketInfo? {
        guard protocolData.count >= 31 else {
            return nil
        }

        var info = FilePacketInfo()
        var pos = LENGTH_FILE_START // Skip start code

        // File type
        info.fileType = protocolData[pos]
        pos += LENGTH_FILE_TYPE

        // Pack size (big-endian)
        info.packSize = (UInt16(protocolData[pos]) << 8) | UInt16(protocolData[pos + 1])
        pos += LENGTH_FILE_PACKSIZE

        // Pack index (big-endian)
        info.packIndex = (UInt16(protocolData[pos]) << 8) | UInt16(protocolData[pos + 1])
        pos += LENGTH_FILE_PACKINDEX

        // File size (big-endian)
        info.fileSize =
            (UInt32(protocolData[pos]) << 24) | (UInt32(protocolData[pos + 1]) << 16)
                | (UInt32(protocolData[pos + 2]) << 8) | UInt32(protocolData[pos + 3])
        pos += LENGTH_FILE_SIZE

        // File name
        let nameBytes = protocolData.subdata(in: pos ..< (pos + LENGTH_FILE_NAME))

        // Find null terminator
        var nameLen = 0
        for i in 0 ..< LENGTH_FILE_NAME {
            if nameBytes[i] == 0 { break }
            nameLen += 1
        }

        if let fileName = String(data: nameBytes.subdata(in: 0 ..< nameLen), encoding: .utf8) {
            info.fileName = fileName
        }
        pos += LENGTH_FILE_NAME

        // Flags (big-endian)
        info.flags = (UInt16(protocolData[pos]) << 8) | UInt16(protocolData[pos + 1])
        pos += LENGTH_FILE_FLAG

        // Verify packet has enough data
        let requiredLength = pos + Int(info.packSize) + LENGTH_FILE_VERIFY + LENGTH_FILE_END
        if protocolData.count < requiredLength {
            print(
                "K900ProtocolUtils: File packet too short for data. Need: \(requiredLength), Have: \(protocolData.count), packSize=\(info.packSize), pos=\(pos)"
            )
            return nil
        }

        // Data
        info.data = protocolData.subdata(in: pos ..< (pos + Int(info.packSize)))
        pos += Int(info.packSize)

        // Verify code
        info.verifyCode = protocolData[pos]
        pos += LENGTH_FILE_VERIFY

        // Check end code
        if protocolData[pos] != CMD_END_CODE[0] || protocolData[pos + 1] != CMD_END_CODE[1] {
            return nil
        }

        // Calculate and verify checksum
        var checkSum = 0
        for byte in info.data {
            checkSum += Int(byte)
        }
        let calculatedVerify = UInt8(checkSum & 0xFF)

        info.isValid = (calculatedVerify == info.verifyCode)

        if !info.isValid {
            print(
                "K900ProtocolUtils: File packet checksum failed. Expected: \(String(format: "%02X", info.verifyCode)), Calculated: \(String(format: "%02X", calculatedVerify))"
            )
        } else {
            print(
                "K900ProtocolUtils: File packet extracted successfully: index=\(info.packIndex), size=\(info.packSize), fileName=\(info.fileName)"
            )
        }

        return info
    }
}

private struct FileTransferSession {
    let fileName: String
    let fileSize: Int // NOTE: May be "fake" (inflated) due to BES firmware workaround
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

    init(fileName: String, fileSize: Int, announcedPackets: Int? = nil) {
        self.fileName = fileName
        self.fileSize = fileSize
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
    /// Detects BES lie: if fileSize is multiple of 400 but actual pack size differs.
    mutating func recalculateTotalPackets(actualPackSize: Int) {
        guard actualPackSize > 0, actualPackSize <= K900ProtocolUtils.FILE_PACK_SIZE else { return }

        self.actualPackSize = actualPackSize

        // Detect BES lie: if fileSize is exact multiple of 400, glasses used the lie strategy
        let isBesLie =
            (fileSize % Self.BES_HARDCODED_PACK_SIZE == 0)
                && (actualPackSize != Self.BES_HARDCODED_PACK_SIZE)

        let newTotalPackets: Int
        if isBesLie {
            // BES lie detected: totalPackets = fileSize / 400
            newTotalPackets = fileSize / Self.BES_HARDCODED_PACK_SIZE
            print(
                "📦 BES Lie detected! fakeFileSize=\(fileSize), totalPackets=\(newTotalPackets), actualPackSize=\(actualPackSize)"
            )
        } else {
            // Normal case: calculate based on actual pack size
            newTotalPackets = (fileSize + actualPackSize - 1) / actualPackSize
        }

        if newTotalPackets != totalPackets {
            print(
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

        if index >= totalPackets {
            totalPackets = index + 1
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

        print(
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

private struct BlePhotoTransfer {
    let bleImgId: String
    let requestId: String
    let webhookUrl: String
    var authToken: String?
    var session: FileTransferSession?
    let phoneStartTime: Date
    var bleTransferStartTime: Date?
    var glassesCompressionDurationMs: Int64 = 0

    init(bleImgId: String, requestId: String, webhookUrl: String) {
        self.bleImgId = bleImgId
        self.requestId = requestId
        self.webhookUrl = webhookUrl
        phoneStartTime = Date()
    }
}

private enum BleIncidentLogRelayKind {
    case firmware
    case logcat
}

private final class BleIncidentLogRelayEntry {
    let fileBaseKey: String
    let incidentId: String
    let apiBaseUrl: String
    let kind: BleIncidentLogRelayKind
    var session: FileTransferSession?

    init(
        fileBaseKey: String, incidentId: String, apiBaseUrl: String, kind: BleIncidentLogRelayKind
    ) {
        self.fileBaseKey = fileBaseKey
        self.incidentId = incidentId
        self.apiBaseUrl = apiBaseUrl
        self.kind = kind
    }
}

// MARK: - CBCentralManagerDelegate

extension MentraLive: CBCentralManagerDelegate {
    // CoreBluetooth delivers these callbacks on `bluetoothQueue`; hop back before touching MainActor state.
    nonisolated func centralManagerDidUpdateState(_ central: CBCentralManager) {
        let state = central.state
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            switch state {
            case .poweredOn:
                Bridge.log("LIVE: Bluetooth powered on")
                // If we have a saved device, try to reconnect
                if let savedDeviceName = UserDefaults.standard.string(forKey: PREFS_DEVICE_NAME),
                   !savedDeviceName.isEmpty
                {
                    self.startScan()
                }

            case .poweredOff:
                Bridge.log("LIVE: Bluetooth is powered off")
                self.updateConnectionState(ConnTypes.DISCONNECTED)

            case .unauthorized:
                Bridge.log("LIVE: Bluetooth is unauthorized")
                self.updateConnectionState(ConnTypes.DISCONNECTED)

            case .unsupported:
                Bridge.log("LIVE: Bluetooth is unsupported")
                self.updateConnectionState(ConnTypes.DISCONNECTED)

            default:
                Bridge.log("LIVE: Bluetooth state: \(state.rawValue)")
            }
        }
    }

    func handleDiscoveredPeripheral(_ peripheral: CBPeripheral, rssi: NSNumber? = nil) {
        guard let name = peripheral.name else { return }

        // Check for compatible device names
        if name == "Xy_A" || name.hasPrefix("XyBLE_") || name.hasPrefix("MENTRA_LIVE_BLE")
            || name.hasPrefix("MENTRA_LIVE_BT") || name.lowercased().hasPrefix("mentra_live")
        {
            let glassType = name == "Xy_A" ? "Standard" : "K900"
            Bridge.log("Found compatible \(glassType) glasses device: \(name)")

            // Store the peripheral
            discoveredPeripherals[name] = peripheral

            emitDiscoveredDevice(name, identifier: peripheral.identifier.uuidString, rssi: rssi?.intValue)

            // Check if this is the device we want to connect to
            if let savedDeviceName = UserDefaults.standard.string(forKey: PREFS_DEVICE_NAME),
               savedDeviceName == name
            {
                Bridge.log("Found our remembered device by name, connecting: \(name)")
                // stopScan()
                centralManager?.stopScan()
                isScanning = false
                connectToDevice(peripheral)
            }
        }
    }

    nonisolated func centralManager(
        _: CBCentralManager, didDiscover peripheral: CBPeripheral,
        advertisementData _: [String: Any], rssi: NSNumber
    ) {
        DispatchQueue.main.async { [weak self] in
            self?.handleDiscoveredPeripheral(peripheral, rssi: rssi)
        }
    }

    nonisolated func centralManager(_: CBCentralManager, didConnect peripheral: CBPeripheral) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            Bridge.log("Connected to GATT server, discovering services...")

            self.stopConnectionTimeout()
            self.isConnecting = false
            self.connectedPeripheral = peripheral

            // Save device name and address for future reconnection
            if let name = peripheral.name {
                UserDefaults.standard.set(name, forKey: PREFS_DEVICE_NAME)
                Bridge.log("Saved device name for future reconnection: \(name)")
                DeviceStore.shared.apply("glasses", "bluetoothName", name)
            }
            // Persist peripheral UUID so DeviceManager can sync it to RN settings
            DeviceStore.shared.apply("bluetooth", "device_address", peripheral.identifier.uuidString)

            // Audio Pairing: Setup Bluetooth audio after BLE connection
            if let deviceName = peripheral.name {
                Bridge.log("BLE connection established, setting up audio...")
                // setupAudioPairing(deviceName: deviceName)
            }

            // Discover services
            peripheral.discoverServices([SERVICE_UUID])

            // Reset reconnect attempts
            self.reconnectAttempts = 0
        }
    }

    nonisolated func centralManager(
        _: CBCentralManager, didDisconnectPeripheral _: CBPeripheral, error _: Error?
    ) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            Bridge.log("LIVE: Disconnected from GATT server")

            self.isConnecting = false

            self.connectedPeripheral = nil
            self.fullyBooted = false
            self.connected = false
            self.updateConnectionState(ConnTypes.DISCONNECTED)
            self.rgbLedAuthorityClaimed = false

            self.stopAllTimers()

            // Clean up characteristics
            self.txCharacteristic = nil
            self.rxCharacteristic = nil

            // Attempt reconnection if not killed
            if !self.isKilled {
                self.handleReconnection()
            }
        }
    }

    nonisolated func centralManager(_: CBCentralManager, didFailToConnect _: CBPeripheral, error: Error?) {
        let errorDescription = error?.localizedDescription ?? "Unknown error"
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            Bridge.log("LIVE: Failed to connect to peripheral: \(errorDescription)")

            self.stopConnectionTimeout()
            self.isConnecting = false
            self.connectedPeripheral = nil
            self.updateConnectionState(ConnTypes.DISCONNECTED)

            if !self.isKilled {
                self.handleReconnection()
            }
        }
    }
}

// MARK: - CBPeripheralDelegate

extension MentraLive: CBPeripheralDelegate {
    nonisolated func peripheral(_: CBPeripheral, didReadRSSI RSSI: NSNumber, error: Error?) {
        let errorDescription = error?.localizedDescription
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.signalStrengthReadInFlight = false
            if let errorDescription {
                Bridge.log("LIVE: Error reading RSSI: \(errorDescription)")
            } else {
                self.updateSignalStrength(Int(truncating: RSSI))
            }
        }
    }

    nonisolated func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        let errorDescription = error?.localizedDescription
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if let errorDescription {
                Bridge.log("LIVE: Error discovering services: \(errorDescription)")
                self.centralManager?.cancelPeripheralConnection(peripheral)
                return
            }

            guard let services = peripheral.services else { return }

            for service in services where service.uuid == SERVICE_UUID {
                Bridge.log("LIVE: Found UART service, discovering characteristics...")
                peripheral.discoverCharacteristics(
                    [
                        TX_CHAR_UUID, RX_CHAR_UUID, FILE_READ_UUID, FILE_WRITE_UUID, LC3_READ_UUID,
                        LC3_WRITE_UUID,
                    ], for: service
                )
            }
        }
    }

    nonisolated func peripheral(
        _ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?
    ) {
        let errorDescription = error?.localizedDescription
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if let errorDescription {
                Bridge.log("LIVE: Error discovering characteristics: \(errorDescription)")
                self.centralManager?.cancelPeripheralConnection(peripheral)
                return
            }

            guard let characteristics = service.characteristics else { return }

            for characteristic in characteristics {
                // Log characteristic properties for debugging
                let props = characteristic.properties
                let propsStr = [
                    props.contains(.notify) ? "NOTIFY" : nil,
                    props.contains(.indicate) ? "INDICATE" : nil,
                    props.contains(.read) ? "READ" : nil,
                    props.contains(.write) ? "WRITE" : nil,
                    props.contains(.writeWithoutResponse) ? "WRITE_NO_RESPONSE" : nil,
                ].compactMap { $0 }.joined(separator: " ")
                Bridge.log("📋 Characteristic \(characteristic.uuid): properties=[\(propsStr)]")

                if characteristic.uuid == TX_CHAR_UUID {
                    self.txCharacteristic = characteristic
                    Bridge.log("LIVE: ✅ Found TX characteristic")
                } else if characteristic.uuid == RX_CHAR_UUID {
                    self.rxCharacteristic = characteristic
                    Bridge.log(
                        "LIVE: ✅ Found RX characteristic - hasNotify=\(props.contains(.notify)), hasIndicate=\(props.contains(.indicate))"
                    )
                } else if characteristic.uuid == FILE_READ_UUID {
                    self.fileReadCharacteristic = characteristic
                    Bridge.log("LIVE: 📁 Found FILE_READ characteristic (72FF)!")
                } else if characteristic.uuid == FILE_WRITE_UUID {
                    self.fileWriteCharacteristic = characteristic
                    Bridge.log("LIVE: 📁 Found FILE_WRITE characteristic (73FF)!")
                } else if characteristic.uuid == LC3_READ_UUID {
                    self.lc3ReadCharacteristic = characteristic
                    Bridge.log("LIVE: 🎤 Found LC3_READ characteristic (audio input)!")
                } else if characteristic.uuid == LC3_WRITE_UUID {
                    self.lc3WriteCharacteristic = characteristic
                    Bridge.log("LIVE: 🎤 Found LC3_WRITE characteristic (audio output)!")
                }
            }

            // Check if we have both characteristics
            if self.txCharacteristic != nil, let rx = self.rxCharacteristic {
                Bridge.log("LIVE: ✅ Both TX and RX characteristics found - BLE connection ready")
                Bridge.log("LIVE: 🔄 Waiting for glasses SOC to become ready...")

                // Don't set connected=true here - wait for SOC to be ready (fullyBooted=true)
                // DeviceStore handles connected state based on fullyBooted

                // Keep state as connecting until glasses are ready
                self.updateConnectionState(ConnTypes.CONNECTING)

                let withResponseMtu = peripheral.maximumWriteValueLength(for: .withResponse) + 3
                let withoutResponseMtu = peripheral.maximumWriteValueLength(for: .withoutResponse) + 3
                self.currentMtu = max(23, min(withResponseMtu, withoutResponseMtu))
                Bridge.log(
                    "LIVE: Current MTU estimate: withResponse=\(withResponseMtu), withoutResponse=\(withoutResponseMtu), selected=\(self.currentMtu)"
                )

                // Enable notifications on RX characteristic
                peripheral.setNotifyValue(true, for: rx)

                // Enable notifications on file characteristics if available
                if let fileRead = self.fileReadCharacteristic {
                    peripheral.setNotifyValue(true, for: fileRead)
                }

                // Enable notifications on LC3 audio characteristic if device supports it
                if self.supportsLC3Audio, let lc3Read = self.lc3ReadCharacteristic {
                    peripheral.setNotifyValue(true, for: lc3Read)
                    Bridge.log("LIVE: 🎤 Enabled LC3 audio notifications")
                }

                // Start readiness check loop
                self.startSignalStrengthPolling()
                self.startReadinessCheckLoop()
            } else {
                Bridge.log("LIVE: Required BLE characteristics not found")
                if self.txCharacteristic == nil {
                    Bridge.log("LIVE: TX characteristic not found")
                }
                if self.rxCharacteristic == nil {
                    Bridge.log("LIVE: RX characteristic not found")
                }
                self.centralManager?.cancelPeripheralConnection(peripheral)
            }
        }
    }

    nonisolated func peripheral(
        _: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?
    ) {
        let uuid = characteristic.uuid
        let data = characteristic.value
        let errorDescription = error?.localizedDescription
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            // Bridge.log("LIVE: DEBUG: didUpdateValueFor CALLED - characteristic: \(uuid), dataSize: \(data?.count ?? 0)")
            // Log raw hex for debugging glasses_ready issue
            if let data {
                let hexString = data.prefix(50).map { String(format: "%02X ", $0) }.joined()
                _ = hexString
                // Bridge.log("LIVE: DEBUG: RAW HEX (first 50): \(hexString)")
            }
            if let errorDescription {
                Bridge.log("LIVE: Error updating value for characteristic: \(errorDescription)")
                return
            }

            guard let data else {
                Bridge.log("LIVE: Characteristic value is nil")
                return
            }

            let threadId = Thread.current.hash
            _ = threadId

            // Bridge.log("Thread-\(threadId): 🎉 didUpdateValueFor CALLBACK TRIGGERED! Characteristic: \(uuid)")
            // if uuid == RX_CHAR_UUID {
            //   Bridge.log("Thread-\(threadId): 🎯 RECEIVED DATA ON RX CHARACTERISTIC (Peripheral's TX)")
            // } else if uuid == TX_CHAR_UUID {
            //   Bridge.log("Thread-\(threadId): 🎯 RECEIVED DATA ON TX CHARACTERISTIC (Peripheral's RX)")
            // }
            // Bridge.log("Thread-\(threadId): 🔍 Processing received data - \(data.count) bytes")

            // Handle LC3 audio data separately (dedicated characteristic for LC3-capable devices)
            if uuid == LC3_READ_UUID && self.supportsLC3Audio {
                // Bridge.log("LIVE: Received data on LC3_READ characteristic (audio input)")
                self.processLc3AudioPacket(data)
                return
            }

            // Handle regular data (JSON messages, file transfers, etc.)
            self.processReceivedData(data)
        }
    }

    nonisolated func peripheral(_: CBPeripheral, didWriteValueFor _: CBCharacteristic, error: Error?) {
        let errorDescription = error?.localizedDescription
        DispatchQueue.main.async {
            if let errorDescription {
                Bridge.log("LIVE: Error writing characteristic: \(errorDescription)")
            } else {
                Bridge.log("LIVE: Characteristic write successful")
            }
        }
    }

    nonisolated func peripheral(
        _: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        let uuid = characteristic.uuid
        let isNotifying = characteristic.isNotifying
        let errorDescription = error?.localizedDescription
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if let errorDescription {
                Bridge.log("LIVE: Error updating notification state: \(errorDescription)")
            } else {
                Bridge.log("Notification state updated for \(uuid): \(isNotifying ? "ON" : "OFF")")

                if uuid == self.RX_CHAR_UUID, isNotifying {
                    Bridge.log("LIVE: 🔔 Ready to receive data via notifications")
                }
            }
        }
    }

    nonisolated func peripheralDidUpdateRSSI(_ peripheral: CBPeripheral, error: Error?) {
        let errorDescription = error?.localizedDescription
        DispatchQueue.main.async {
            if let errorDescription {
                Bridge.log("LIVE: Error reading RSSI: \(errorDescription)")
            } else {
                Bridge.log("LIVE: RSSI: \(peripheral.readRSSI())")
            }
        }
    }
}

enum MentraLiveError: Error {
    case bluetoothNotAvailable
    case bluetoothNotPowered
    case connectionTimeout
    case missingCharacteristics
    case missingPermissions
}

enum MentraLiveConnectionState {
    case disconnected
    case connecting
    case connected
}

/// Type aliases for compatibility
typealias JSONObject = [String: Any]

// MARK: - Main Manager Class

@MainActor
class MentraLive: NSObject, SGCManager {
    // Feature Flags
    // BLOCK_AUDIO_DUPLEX: When true, suspends LC3 mic while phone is playing audio via A2DP
    // to avoid overloading the MCU. Set to false to allow simultaneous A2DP + LC3 mic.
    private let BLOCK_AUDIO_DUPLEX = false
    private static let voiceActivityDetectionSwitchType = 8

    var connectionState: String = ConnTypes.DISCONNECTED

    /// Mirrors Android `updateConnectionState` — RN home reads `glasses.connectionState` for reconnecting UI.
    private func updateConnectionState(_ state: String) {
        connectionState = state
        DeviceStore.shared.apply("glasses", "connectionState", state)
        // Drop OTA caches when fully disconnected — avoids leaking session/step state from
        // a previous pairing into the next one (would otherwise surface as wrong overall_percent
        // or stale lastBesOtaProgress on the next OTA).
        if state == ConnTypes.DISCONNECTED {
            incomingChunkReassembler.clear()
            stopSignalStrengthPolling()
            DeviceStore.shared.apply("glasses", "signalStrength", -1)
            DeviceStore.shared.apply("glasses", "signalStrengthUpdatedAt", 0)
            resetOtaCache()
        }
    }

    func setDashboardPosition(_: Int, _: Int) {}
    func setSilentMode(_: Bool) {}
    func exit() {}
    func showDashboard() {}
    func displayBitmap(base64ImageData _: String, x _: Int32? = nil, y _: Int32? = nil, width _: Int32? = nil, height _: Int32? = nil) async -> Bool {
        return true
    }

    func sendDoubleTextWall(_: String, _: String) async {}
    func setHeadUpAngle(_: Int) {}
    func getBatteryStatus() {}
    func setBrightness(_: Int, autoMode _: Bool) {}
    func clearDisplay() {}
    func sendText(_ text: String) async {
        await sendTextWall(text)
    }
    func sendTextWall(_: String) async {}
    func ping() {
        Bridge.log("LIVE: ping()")
        keepAwake()
    }

    func connectController() {}
    func disconnectController() {}

    func dbg1() {}
    func dbg2() {}

    func forget() {
        Bridge.log("LIVE: Forgetting Mentra Live glasses")

        // Stop scanning first
        if isScanning {
            stopScan()
            emitStopScanEvent()
        }

        // Then do full cleanup (disconnect + clear all references)
        destroy()
    }

    var type = "Mentra Live"
    var hasMic = true

    func setMicEnabled(_ enabled: Bool) {
        Bridge.log("LIVE: 🎤 Microphone state change requested: \(enabled)")
        DeviceStore.shared.apply("glasses", "micEnabled", enabled)

        // Only enable if device supports LC3 audio
        guard supportsLC3Audio else {
            Bridge.log("LIVE: Device does not support LC3 audio, ignoring mic enable request")
            return
        }

        // Update shouldUseGlassesMic based on enabled state
        shouldUseGlassesMic = enabled

        // Update the intent state for the suspend/resume state machine
        micIntentEnabled = enabled

        if enabled {
            // User wants mic ON
            // Check if we should suspend due to phone audio (only if BLOCK_AUDIO_DUPLEX is enabled)
            if BLOCK_AUDIO_DUPLEX, let monitor = phoneAudioMonitor, monitor.isPlaying() {
                // Phone is currently playing audio - don't start mic yet, mark as suspended
                micSuspendedForAudio = true
                Bridge.log(
                    "LIVE: 🎤 Mic requested but phone audio is playing - suspending until audio stops"
                )
            } else {
                // Safe to start mic
                micSuspendedForAudio = false
                Bridge.log("LIVE: 🎤 Microphone enabled, starting audio input handling")
                startMicBeat()
            }
        } else {
            // User wants mic OFF - clear suspended state and stop
            micSuspendedForAudio = false
            Bridge.log("LIVE: 🎤 Microphone disabled, stopping audio input handling")
            stopMicBeat()
        }
    }

    func sortMicRanking(list: [String]) -> [String] {
        return list
    }

    // BLE UUIDs
    private let SERVICE_UUID = CBUUID(string: "00004860-0000-1000-8000-00805f9b34fb")
    private let RX_CHAR_UUID = CBUUID(string: "000070FF-0000-1000-8000-00805f9b34fb") // Central receives on peripheral's TX
    private let TX_CHAR_UUID = CBUUID(string: "000071FF-0000-1000-8000-00805f9b34fb") // Central transmits on peripheral's RX
    private let FILE_READ_UUID = CBUUID(string: "000072FF-0000-1000-8000-00805f9b34fb")
    private let FILE_WRITE_UUID = CBUUID(string: "000073FF-0000-1000-8000-00805f9b34fb")

    // LC3 Audio UUIDs (for K901+ devices with microphone support)
    private let LC3_READ_UUID = CBUUID(string: "6E400002-B5A3-F393-E0A9-E50E24DCCA9E")
    private let LC3_WRITE_UUID = CBUUID(string: "6E400003-B5A3-F393-E0A9-E50E24DCCA9E")

    private let FILE_SAVE_DIR = "MentraLive_Images"

    // NEW: File transfer properties
    private var fileReadCharacteristic: CBCharacteristic?
    private var fileWriteCharacteristic: CBCharacteristic?
    private var activeFileTransfers = [String: FileTransferSession]()
    private var blePhotoTransfers = [String: BlePhotoTransfer]()
    private var bleIncidentLogRelays = [String: BleIncidentLogRelayEntry]()
    private var rgbLedAuthorityClaimed = false

    // LC3 Audio properties
    private var lc3ReadCharacteristic: CBCharacteristic?
    private var lc3WriteCharacteristic: CBCharacteristic?
    private var supportsLC3Audio = true
    private var lastReceivedLc3Sequence: Int8 = -1
    private let LC3_FRAME_SIZE = 40 // bytes per LC3 frame
    private let MICBEAT_INTERVAL_MS: TimeInterval = 30 * 60 // 30 minutes in seconds
    private var micBeatTimer: Timer?
    private var micBeatCount = 0
    private var shouldUseGlassesMic = false

    // LC3 Mic suspend/resume state machine for A2DP conflict avoidance
    // When phone plays audio via A2DP while LC3 mic is active, it overloads the MCU
    // So we temporarily suspend the LC3 mic during phone audio playback
    private var micIntentEnabled = false // User/system WANTS mic enabled
    private var micSuspendedForAudio = false // Mic temporarily suspended due to phone audio
    private var phoneAudioMonitor: PhoneAudioMonitor?

    // Timing Constants
    private let BASE_RECONNECT_DELAY_MS: UInt64 = 1_000_000_000 // 1 second in nanoseconds
    private let MAX_RECONNECT_DELAY_MS: UInt64 = 30_000_000_000 // 30 seconds
    private let MAX_RECONNECT_ATTEMPTS = 10
    private let KEEP_ALIVE_INTERVAL_MS: UInt64 = 5_000_000_000 // 5 seconds
    private let CONNECTION_TIMEOUT_MS: UInt64 = 100_000_000_000 // 100 seconds
    private let HEARTBEAT_INTERVAL_MS: TimeInterval = 30.0 // 30 seconds
    private let BATTERY_REQUEST_EVERY_N_HEARTBEATS = 10
    private let SIGNAL_STRENGTH_READ_INTERVAL_MS: TimeInterval = 10.0
    private let MIN_SEND_DELAY_MS: UInt64 = 160_000_000 // 160ms in nanoseconds
    private let READINESS_CHECK_INTERVAL_MS: TimeInterval = 2.5 // 2.5 seconds

    /// Device Settings Keys
    private let PREFS_DEVICE_NAME = "MentraLiveLastConnectedDeviceName"

    // MARK: - Properties

    @objc static func requiresMainQueueSetup() -> Bool {
        true
    }

    /// BLE Properties
    private var centralManager: CBCentralManager?

    private var connectedPeripheral: CBPeripheral?
    private var txCharacteristic: CBCharacteristic?
    private var rxCharacteristic: CBCharacteristic?
    private let bes2700MtuLimit = 256
    private var currentMtu: Int = 23 // Default BLE MTU

    // State Tracking
    private var isScanning = false
    private var isConnecting = false
    private var isKilled = false
    private var reconnectAttempts = 0
    private var isNewVersion = false
    private var globalMessageId = 0
    private var lastReceivedMessageId = 0

    private var fullyBooted: Bool {
        get { DeviceStore.shared.get("glasses", "fullyBooted") as? Bool ?? false }
        set { DeviceStore.shared.apply("glasses", "fullyBooted", newValue) }
    }

    private var connected: Bool {
        get { DeviceStore.shared.get("glasses", "connected") as? Bool ?? false }
        set { DeviceStore.shared.apply("glasses", "connected", newValue) }
    }

    // Queue Management
    private let commandQueue = CommandQueue()
    private let bluetoothQueue = DispatchQueue(label: "MentraLiveBluetooth", qos: .userInitiated)
    private let incomingChunkReassembler = MessageChunkReassembler()
    private var lastSendTimeMs: TimeInterval = 0

    // Timers
    private var heartbeatTimer: Timer?
    private var heartbeatCounter = 0
    private var signalStrengthTimer: DispatchSourceTimer?
    private var signalStrengthReadInFlight = false
    private var readinessCheckTimer: Timer?
    private var readinessCheckCounter = 0

    /// BES OTA progress tracking - only send to UI on 5% increments
    private var lastBesOtaProgress = -1

    // Cached OTA session context from last ota_status — used to fill in session fields for sr_adota
    private var cachedOtaSessionId: String?
    private var cachedOtaTotalSteps = 0
    private var cachedOtaCurrentStep = 0
    /// Step type sequence (e.g. ["apk","bes"]) from last ota_status; used to compute BES weight in sr_adota.
    private var cachedOtaStepSequence: [String]?

    // Glasses media volume (K900 cs_getvol / cs_vol, sr_getvol / sr_vol)
    private let glassesMediaVolumeLock = NSLock()
    private var glassesMediaVolumeGetCompletion: ((Result<[String: Any], Error>) -> Void)?
    private var glassesMediaVolumeSetCompletion: ((Result<[String: Any], Error>) -> Void)?
    private var glassesMediaVolumeTimeoutWorkItem: DispatchWorkItem?
    private static let glassesMediaVolumeTimeoutSec: TimeInterval = 2.0

    private var connectionTimeoutTimer: Timer?
    private var reconnectionWorkItem: DispatchWorkItem?

    // MARK: - Initialization

    override init() {
        super.init()
        setupCommandQueue()

        // Initialize phone audio monitor for LC3 mic suspend/resume (if enabled)
        // This detects when phone is playing audio and temporarily suspends LC3 mic
        // to avoid overloading the MCU when both A2DP output and LC3 mic input are active
        if BLOCK_AUDIO_DUPLEX {
            phoneAudioMonitor = PhoneAudioMonitor.getInstance()
            phoneAudioMonitor?.startMonitoring(listener: self)
            Bridge.log(
                "LIVE: 🎵 Phone audio monitor started for LC3 mic suspend/resume (BLOCK_AUDIO_DUPLEX=true)"
            )
        } else {
            Bridge.log("LIVE: 🎵 Phone audio monitor disabled (BLOCK_AUDIO_DUPLEX=false)")
        }
    }

    deinit {
        // Prevent delegate callbacks to deallocated object
        centralManager?.delegate = nil
        connectedPeripheral?.delegate = nil
        Bridge.log("MentraLive: deinitialized")
    }

    func cleanup() {
        destroy()
    }

    // MARK: - React Native Interface

    private var discoveredPeripherals = [String: CBPeripheral]() // name -> peripheral

    func findCompatibleDevices() {
        Bridge.log("Finding compatible Mentra Live glasses")

        Task {
            if centralManager == nil {
                centralManager = CBCentralManager(
                    delegate: self, queue: bluetoothQueue,
                    options: ["CBCentralManagerOptionShowPowerAlertKey": 0]
                )
                // wait for the central manager to be fully initialized before we start scanning:
                try? await Task.sleep(nanoseconds: 100 * 1_000_000) // 100ms
            }

            // clear the saved device name:
            UserDefaults.standard.set("", forKey: PREFS_DEVICE_NAME)

            startScan()
        }
    }

    func connectById(_ deviceName: String) {
        Bridge.log("connectById: \(deviceName)")
        // Save the device name for future reconnection
        UserDefaults.standard.set(deviceName, forKey: PREFS_DEVICE_NAME)

        // Start scanning to find this specific device
        if centralManager == nil {
            centralManager = CBCentralManager(
                delegate: self, queue: bluetoothQueue,
                options: ["CBCentralManagerOptionShowPowerAlertKey": 0]
            )
        }

        // Check for already-connected peripherals first
        let connectedPeripherals = centralManager!.retrieveConnectedPeripherals(withServices: [
            SERVICE_UUID,
        ])
        for peripheral in connectedPeripherals {
            Bridge.log("Found already-connected peripheral: \(peripheral.name ?? "Unknown")")
            if let name = peripheral.name,
               name == "Xy_A" || name.hasPrefix("XyBLE_") || name.hasPrefix("MENTRA_LIVE_BLE")
               || name.hasPrefix("MENTRA_LIVE_BT")
            {
                Bridge.log("Found already-connected peripheral: \(name)")
                discoveredPeripherals[name] = peripheral
                emitDiscoveredDevice(name)

                // Check if this is the device we want
                if let savedDeviceName = UserDefaults.standard.string(
                    forKey: PREFS_DEVICE_NAME
                ),
                    savedDeviceName == name
                {
                    Bridge.log(
                        "Found our remembered device already connected, connecting: \(name)"
                    )
                    connectToDevice(peripheral)
                    return
                }
            }
        }

        // Will connect when found during scan
        startScan()
    }

    func getConnectedBluetoothName() -> String? {
        return connectedPeripheral?.name
    }

    @objc func disconnect() {
        Bridge.log("LIVE: disconnect() -Disconnecting from Mentra Live glasses")

        // if rgbLedAuthorityClaimed {
        //     sendRgbLedControlAuthority(false)
        // }

        // // Clear any pending messages
        // pending = nil
        // pendingMessageTimer?.invalidate()
        // pendingMessageTimer = nil

        // if let peripheral = connectedPeripheral {
        //     centralManager?.cancelPeripheralConnection(peripheral)
        // }

        // stopAllTimers()
        // connectionState = ConnTypes.DISCONNECTED
        // rgbLedAuthorityClaimed = false
        destroy()
    }

    // MARK: - Micbeat System (LC3 Audio Keepalive)

    /// Start the micbeat mechanism to keep LC3 audio streaming active
    private func startMicBeat() {
        Bridge.log("LIVE: 🎤 Starting micbeat mechanism")
        micBeatCount = 0

        // Send initial command to enable custom audio TX
        sendEnableCustomAudioTxMessage(shouldUseGlassesMic)

        // Stop any existing timer
        micBeatTimer?.invalidate()

        // Schedule periodic micbeat (every 30 minutes)
        micBeatTimer = Timer.scheduledTimer(withTimeInterval: MICBEAT_INTERVAL_MS, repeats: true) {
            [weak self] _ in
            guard let self = self else { return }
            Bridge.log("LIVE: 🎤 Sending micbeat - enabling custom audio TX")
            self.sendEnableCustomAudioTxMessage(self.shouldUseGlassesMic)
            self.micBeatCount += 1
        }

        Bridge.log("LIVE: Micbeat scheduled every \(MICBEAT_INTERVAL_MS / 60) minutes")
    }

    /// Stop the micbeat mechanism
    private func stopMicBeat() {
        Bridge.log("LIVE: 🎤 Stopping micbeat mechanism")
        sendEnableCustomAudioTxMessage(false)
        micBeatTimer?.invalidate()
        micBeatTimer = nil
        micBeatCount = 0
    }

    /// Send command to enable/disable custom audio TX on glasses
    @objc func sendEnableCustomAudioTxMessage(_ enabled: Bool) {
        Bridge.log("LIVE: Setting microphone state to: \(enabled)")

        do {
            let enableData = try JSONSerialization.data(withJSONObject: ["enable": enabled])
            let enableString = String(data: enableData, encoding: .utf8) ?? ""

            let command: [String: Any] = [
                "C": "enable_custom_audio_tx",
                "B": enableString,
            ]

            if sendRawK900Command(command) {
                Bridge.log("LIVE: Sent enable_custom_audio_tx via queue (BES-handled command)")
            } else {
                Bridge.log("LIVE: Failed to send enable_custom_audio_tx")
            }
        } catch {
            Bridge.log("Error creating enable_custom_audio_tx request: \(error)")
        }
    }

    func requestPhoto(_ request: PhotoRequest) {
        Bridge.log(
            "LIVE: PHOTO PIPELINE [5/6] requestPhoto() entry requestId=\(request.requestId) appId=\(request.appId) flash=\(request.flash) save=\(request.save) sound=\(request.sound) iso=\(request.iso.map { String($0) } ?? "auto") aeDivisor=\(request.aeExposureDivisor.map { String($0) } ?? "nil")"
        )

        var json: [String: Any] = [
            "type": "take_photo",
            "requestId": request.requestId,
            "appId": request.appId,
        ]

        // Always generate BLE ID for potential fallback
        let bleImgId =
            "I" + String(format: "%09d", Int(Date().timeIntervalSince1970 * 1000) % 100_000_000)
        json["bleImgId"] = bleImgId
        json["transferMethod"] = "auto"

        if let webhookUrl = request.webhookUrl, !webhookUrl.isEmpty {
            json["webhookUrl"] = webhookUrl

            var transfer = BlePhotoTransfer(
                bleImgId: bleImgId, requestId: request.requestId, webhookUrl: webhookUrl
            )

            // Store authToken for BLE transfer if provided
            if let authToken = request.authToken, !authToken.isEmpty {
                transfer.authToken = authToken
            }

            blePhotoTransfers[bleImgId] = transfer
        }

        // Add authToken to JSON if provided
        if let authToken = request.authToken, !authToken.isEmpty {
            json["authToken"] = authToken
        }

        let allowedSizes = ["low", "medium", "high", "max"]
        let size = request.size.rawValue
        json["size"] = allowedSizes.contains(size) ? size : "medium"

        json["compress"] = request.compress?.rawValue ?? "none"
        json["flash"] = request.flash
        json["save"] = request.save
        json["sound"] = request.sound

        if let e = request.exposureTimeNs, e.isFinite, e > 0, e <= Double(Int64.max) {
            Bridge.log("LIVE: Using manual exposure time for photo request \(request.requestId): \(Int64(e)) ns")
            json["exposureTimeNs"] = Int64(e)
        }
        if let iso = request.iso, iso > 0 {
            Bridge.log("LIVE: Using manual ISO for photo request \(request.requestId): ISO \(iso)")
            json["iso"] = iso
        }
        request.appendScanFields(to: &json)

        Bridge.log("LIVE: PHOTO PIPELINE [5b/6] take_photo JSON ready bleImgId=\(bleImgId) transferMethod=auto")
        Bridge.log("LIVE: PHOTO PIPELINE [6/6] Dispatching take_photo to sendJson()")

        sendJson(json, wakeUp: true)
    }

    func startStream(_ message: [String: Any]) {
        Bridge.log("Starting stream")
        var json = message
        json.removeValue(forKey: "timestamp")
        sendJson(json, wakeUp: true)
    }

    func stopStream() {
        Bridge.log("Stopping stream")
        let json: [String: Any] = ["type": "stop_stream"]
        sendJson(json, wakeUp: true)
    }

    func sendStreamKeepAlive(_ message: [String: Any]) {
        Bridge.log("Sending stream keep alive")
        sendJson(message)
    }

    @objc func startRecordVideo() {
        let json: [String: Any] = ["type": "start_record_video"]
        sendJson(json, wakeUp: true)
    }

    @objc func stopRecordVideo() {
        let json: [String: Any] = ["type": "stop_record_video"]
        sendJson(json, wakeUp: true)
    }

    @objc func startVideoStream() {
        let json: [String: Any] = ["type": "start_video_stream"]
        sendJson(json, wakeUp: true)
    }

    @objc func stopVideoStream() {
        let json: [String: Any] = ["type": "stop_video_stream"]
        sendJson(json, wakeUp: true)
    }

    // MARK: - Command Queue

    class PendingMessage {
        init(data: Data, id: String, retries: Int) {
            self.data = data
            self.id = id
            self.retries = retries
        }

        let data: Data
        let retries: Int
        let id: String
    }

    private var pending: PendingMessage?
    private var pendingMessageTimer: Timer?

    actor CommandQueue {
        private var commands: [PendingMessage] = []

        func enqueue(_ command: PendingMessage) {
            commands.append(command)
        }

        func pushToFront(_ command: PendingMessage) {
            commands.insert(command, at: 0)
        }

        func dequeue() -> PendingMessage? {
            guard !commands.isEmpty else { return nil }
            return commands.removeFirst()
        }
    }

    private func setupCommandQueue() {
        Task.detached { [weak self] in
            guard let self else { return }
            while true {
                let pendingIsNil = await MainActor.run { self.pending == nil }
                if pendingIsNil {
                    if let command = await self.commandQueue.dequeue() {
                        await self.processSendQueue(command)
                    }
                }
                try? await Task.sleep(nanoseconds: 100_000_000) // 100ms
            }
        }
    }

    private func processSendQueue(_ message: PendingMessage) async {
        guard let peripheral = connectedPeripheral,
              let txChar = txCharacteristic
        else {
            return
        }

        // Enforce rate limiting
        let currentTime = Date().timeIntervalSince1970 * 1000
        let timeSinceLastSend = currentTime - lastSendTimeMs

        try? await Task.sleep(nanoseconds: UInt64(1_000_000))
        lastSendTimeMs = Date().timeIntervalSince1970 * 1000

        // Send the data
        peripheral.writeValue(message.data, for: txChar, type: .withResponse)

        // don't do the retry system on the old glasses versions
        if !isNewVersion {
            return
        }

        // Only set as pending and track ACK if ID is not "-1"
        // ID of "-1" means no ACK tracking (e.g., for heartbeats)
        if message.id != "-1" {
            // Set the pending message
            pending = message

            // Start retry timer for 1s
            DispatchQueue.main.async { [weak self] in
                self?.pendingMessageTimer?.invalidate()
                self?.pendingMessageTimer = Timer.scheduledTimer(
                    withTimeInterval: 1, repeats: false
                ) { _ in
                    self?.handlePendingMessageTimeout()
                }
            }
        }
        // If ID is "-1", don't track for ACK - just send and forget
    }

    private func handlePendingMessageTimeout() {
        guard let pendingMessage = pending else { return }

        Bridge.log(
            "⚠️ Message timeout - no response for mId: \(pendingMessage.id), retry attempt: \(pendingMessage.retries + 1)/3"
        )

        // Clear the pending message
        pending = nil

        // Check if we should retry
        if pendingMessage.retries < 3 {
            // Create a new message with incremented retry count
            let retryMessage = PendingMessage(
                data: pendingMessage.data,
                id: pendingMessage.id,
                retries: pendingMessage.retries + 1
            )

            // Push to front of queue for immediate retry
            Task {
                await self.commandQueue.pushToFront(retryMessage)
            }

            Bridge.log(
                "🔄 Retrying message mId: \(pendingMessage.id) (attempt \(retryMessage.retries)/3)"
            )
        } else {
            Bridge.log("❌ Message failed after 3 retries - mId: \(pendingMessage.id)")
            // Optionally emit an event or callback for failed message
        }
    }

    // MARK: - BLE Scanning

    private func startScan() {
        // guard !isScanning else { return }

        guard centralManager!.state == .poweredOn else {
            Bridge.log("Attempting to scan but bluetooth is not powered on.")
            return
        }

        Bridge.log("Starting BLE scan for Mentra Live glasses")
        isScanning = true

        startReadinessCheckLoop()

        let scanOptions: [String: Any] = [
            CBCentralManagerScanOptionAllowDuplicatesKey: false,
        ]

        // let knownPeripherals = centralManager?.retrieveConnectedPeripherals(withServices: [SERVICE_UUID])
        // // check already known peripherals:
        // for peripheral in knownPeripherals {
        //     handleDiscoveredPeripheral(peripheral)
        // }

        centralManager?.scanForPeripherals(withServices: nil, options: scanOptions)

        // emit already discovered peripherals:
        for (_, peripheral) in discoveredPeripherals {
            Bridge.log("LIVE: (Already discovered) peripheral: \(peripheral.name ?? "Unknown")")
            emitDiscoveredDevice(peripheral.name!)
        }

        // var dName = DeviceManager.shared.deviceName
        // if dName.isEmpty {
        //     dName = "MENTRA_LIVE"
        // }

        // setupAudioPairing(deviceName: dName)

        //    // Set scan timeout
        //    DispatchQueue.main.asyncAfter(deadline: .now() + 60.0) { [weak self] in
        //      if self?.isScanning == true {
        //        Bridge.log("Scan timeout reached - stopping BLE scan")
        //        self?.stopScan()
        //      }
        //    }
    }

    func stopScan() {
        guard isScanning else { return }

        centralManager?.stopScan()
        isScanning = false
        DeviceStore.shared.apply(ObservableStore.bluetoothCategory, "searching", false)
        Bridge.log("LIVE: BLE scan stopped")
    }

    // MARK: - Connection Management

    private func connectToDevice(_ peripheral: CBPeripheral) {
        Bridge.log("LIVE: Connecting to device: \(peripheral.identifier.uuidString)")

        isConnecting = true
        updateConnectionState(ConnTypes.CONNECTING)
        connectedPeripheral = peripheral
        peripheral.delegate = self

        // Set connection timeout
        startConnectionTimeout()

        centralManager?.connect(peripheral, options: nil)
    }

    private func handleReconnection() {
        if isKilled {
            Bridge.log("LIVE: Reconnection aborted - device has been killed")
            return
        }

        // Check if we've exceeded max attempts
        if reconnectAttempts >= MAX_RECONNECT_ATTEMPTS {
            Bridge.log("LIVE: Maximum reconnection attempts reached (\(MAX_RECONNECT_ATTEMPTS))")
            reconnectAttempts = 0
            updateConnectionState(ConnTypes.DISCONNECTED)
            connected = false
            fullyBooted = false
            return
        }

        // Calculate delay with exponential backoff
        let delayNanoseconds = min(
            BASE_RECONNECT_DELAY_MS * UInt64(1 << reconnectAttempts), MAX_RECONNECT_DELAY_MS
        )
        reconnectAttempts += 1

        // RN keys off connectionState for reconnecting affordance during backoff (matches Android).
        updateConnectionState(ConnTypes.CONNECTING)

        Bridge.log(
            "LIVE: Scheduling reconnection attempt \(reconnectAttempts) in \(Double(delayNanoseconds) / 1_000_000_000)s (max \(MAX_RECONNECT_ATTEMPTS))"
        )

        // Schedule reconnection attempt
        let workItem = DispatchWorkItem { [weak self] in
            guard let self = self else { return }

            // Use peripheral presence, not connectionState: we stay CONNECTING during backoff until scan/connect.
            if self.connectedPeripheral == nil, !self.isKilled {
                // Check for last known device name to start scan
                if let lastDeviceName = UserDefaults.standard.string(
                    forKey: self.PREFS_DEVICE_NAME
                ), !lastDeviceName.isEmpty {
                    Bridge.log(
                        "LIVE: Reconnection attempt \(self.reconnectAttempts) - looking for device with name: \(lastDeviceName)"
                    )
                    // Start scan to find this device
                    // The scan will automatically connect if it finds a device with the saved name
                    self.startScan()
                } else {
                    Bridge.log(
                        "LIVE: Reconnection attempt \(self.reconnectAttempts) - no last device name available"
                    )
                    self.updateConnectionState(ConnTypes.DISCONNECTED)
                }
            }
        }

        // Store the work item so it can be cancelled if needed
        reconnectionWorkItem = workItem

        // Schedule the work item
        DispatchQueue.main.asyncAfter(
            deadline: .now() + .nanoseconds(Int(delayNanoseconds)), execute: workItem
        )
    }

    // MARK: - Data Processing

    private func processReceivedData(_ data: Data) {
        guard data.count > 0 else { return }

        let bytes = [UInt8](data)

        // Log first few bytes for debugging
        let hexString = data.prefix(16).map { String(format: "%02X ", $0) }.joined()
        // Bridge.log("LIVE: Processing data packet, first \(min(data.count, 16)) bytes: \(hexString)")

        // Check for K900 protocol format (starts with ##)
        if data.count >= 7, bytes[0] == 0x23, bytes[1] == 0x23 {
            processK900ProtocolData(data)
            return
        }

        // Check for JSON data
        if bytes[0] == 0x7B { // '{'
            if let jsonString = String(data: data, encoding: .utf8),
               jsonString.hasPrefix("{"), jsonString.hasSuffix("}")
            {
                processJsonMessage(jsonString)
            }
        }
    }

    private func processK900ProtocolData(_ data: Data) {
        let bytes = [UInt8](data)

        let commandType = bytes[2]

        // Check if this is a file transfer packet
        if commandType == K900ProtocolUtils.CMD_TYPE_PHOTO
            || commandType == K900ProtocolUtils.CMD_TYPE_VIDEO
            || commandType == K900ProtocolUtils.CMD_TYPE_AUDIO
            || commandType == K900ProtocolUtils.CMD_TYPE_DATA
        {
            Bridge.log(
                "📦 DETECTED FILE TRANSFER PACKET (type: 0x\(String(format: "%02X", commandType)))"
            )

            // Debug: Log the raw data
            // let hexDump = data.prefix(64).map { String(format: "%02X ", $0) }.joined()
            // Bridge.log("📦 Raw file packet data length=\(data.count), first 64 bytes: \(hexDump)")

            // The data IS the file packet - it starts with ## and contains the full file packet structure
            if let packetInfo = K900ProtocolUtils.extractFilePacket(data) {
                processFilePacket(packetInfo)
            } else {
                Bridge.log("Failed to extract or validate file packet")
                // BES chip handles ACKs automatically
            }

            return // Exit after processing file packet
        }

        let payloadLength: Int

        // Determine endianness based on device name
        if let deviceName = connectedPeripheral?.name,
           deviceName.hasPrefix("XyBLE_") || deviceName.lowercased().hasPrefix("mentra_live")
        {
            // K900 device - big-endian
            payloadLength = (Int(bytes[3]) << 8) | Int(bytes[4])
        } else {
            // Standard device - little-endian
            payloadLength = (Int(bytes[4]) << 8) | Int(bytes[3])
        }

        // Bridge.log(
        //     "K900 Protocol - Command: 0x\(String(format: "%02X", commandType)), Payload length: \(payloadLength)"
        // )

        // Extract payload if it's JSON data
        if commandType == 0x30, data.count >= payloadLength + 7 {
            if bytes[5 + payloadLength] == 0x24, bytes[6 + payloadLength] == 0x24 {
                let payloadData = data.subdata(in: 5 ..< (5 + payloadLength))
                if let payloadString = String(data: payloadData, encoding: .utf8) {
                    processJsonMessage(payloadString)
                }
            }
        }
    }

    private func processJsonMessage(_ jsonString: String) {
        // Bridge.log("Got JSON from glasses: \(jsonString)")

        do {
            guard let data = jsonString.data(using: .utf8),
                  let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            else {
                return
            }

            processJsonObject(json)
        } catch {
            Bridge.log("Error parsing JSON: \(error)")
        }
    }

    private func processJsonObject(_ json: [String: Any]) {
        // Log ALL incoming JSON objects for debugging
        // Bridge.log("LIVE: DEBUG: processJsonObject: \(json)")

        if MessageChunker.isChunkedMessage(json) {
            processChunkedJsonObject(json)
            return
        }

        // Check for K900 command format
        if let command = json["C"] as? String {
            processK900JsonMessage(json)
            return
        }

        guard let type = json["type"] as? String else {
            // Bridge.log("⚠️ JSON has no 'type' field and no 'C' field - ignoring")
            return
        }

        // Check if this is an ACK response first (for our phone → glasses messages)
        if type == "msg_ack" {
            if let mId = json["mId"] as? Int {
                Bridge.log("LIVE: Received msg_ack for mId: \(mId)")
                if String(mId) == pending?.id {
                    Bridge.log("LIVE: Received expected ACK! clearing pending")
                    pending = nil
                    // Cancel the retry timer
                    pendingMessageTimer?.invalidate()
                    pendingMessageTimer = nil
                } else if pending?.id != nil {
                    Bridge.log(
                        "LIVE: Received unexpected ACK! expected: \(pending!.id), received: \(mId)"
                    )
                }
            }
            return // Don't send ACK for ACKs!
        }

        // Check for message ID that needs ACK (glasses → phone)
        // But only if it's NOT an ACK message
        if let mId = json["mId"] as? Int {
            Bridge.log("LIVE: Received message with mId: \(mId) - sending ACK back to glasses")
            sendAckToGlasses(messageId: mId)
        }

        switch type {
        case "glasses_ready":
            handleGlassesReady()

        case "battery_status":
            let level = json["level"] as? Int ?? batteryLevel
            let isCharging = json["charging"] as? Bool ?? charging
            updateBatteryStatus(level: level, isCharging: isCharging)

        case "voice_activity_detection_status":
            let enabled = json["voiceActivityDetectionEnabled"] as? Bool
                ?? BluetoothSdkDefaults.voiceActivityDetectionEnabled
            handleVoiceActivityDetectionStatus(enabled: enabled)

        case "speaking_status":
            let speaking = json["speaking"] as? Bool ?? false
            handleSpeakingStatus(speaking: speaking)

        case "wifi_status":
            let connected = json["connected"] as? Bool ?? false
            let ssid = json["ssid"] as? String ?? ""
            let ip = json["local_ip"] as? String ?? ""
            updateWifiStatus(connected: connected, ssid: ssid, ip: ip)

        case "hotspot_status_update":
            let enabled = json["hotspot_enabled"] as? Bool ?? false
            let ssid = json["hotspot_ssid"] as? String ?? ""
            let password = json["hotspot_password"] as? String ?? ""
            let ip = json["hotspot_gateway_ip"] as? String ?? ""
            updateHotspotStatus(enabled: enabled, ssid: ssid, password: password, ip: ip)

        case "hotspot_error":
            let errorMessage = json["error_message"] as? String ?? "Unknown hotspot error"
            let timestamp =
                json["timestamp"] as? Int64 ?? Int64(Date().timeIntervalSince1970 * 1000)
            handleHotspotError(errorMessage: errorMessage, timestamp: timestamp)

        case "wifi_scan_result":
            handleWifiScanResult(json)

        case "stream_status":
            emitRtmpStreamStatus(json)

        case "video_recording_status":
            emitVideoRecordingStatus(json)

        case "media_success", "media_error":
            Bridge.sendMediaUploadEvent(type: type, values: json)

        case "photo_status":
            emitPhotoStatus(json)

        case "photo_response":
            emitPhotoResponse(json)

        case "gallery_status":
            let photoCount = json["photos"] as? Int ?? 0
            let videoCount = json["videos"] as? Int ?? 0
            let totalCount = json["total"] as? Int ?? 0
            let totalSize = json["total_size"] as? Int64 ?? 0
            let hasContent = json["has_content"] as? Bool ?? false
            let cameraBusy = Self.galleryCameraBusy(json)
            let cameraBusyReason = Self.galleryCameraBusyReason(json)
            handleGalleryStatus(
                photoCount: photoCount, videoCount: videoCount,
                totalCount: totalCount, totalSize: totalSize,
                hasContent: hasContent,
                cameraBusy: cameraBusy,
                cameraBusyReason: cameraBusyReason
            )

        case "settings_ack":
            emitSettingsAck(json)

        case "button_press":
            handleButtonPress(json)

        // Removed: version_info_1, version_info_2, and version_info cases
        // Now handled by flexible parsing in the default case below

        case "touch_event":
            let gestureName = json["gesture_name"] as? String ?? "unknown"
            let timestamp = parseTimestamp(json["timestamp"])
            let deviceModel = json["device_model"] as? String ?? deviceModel
        // Bridge.sendTouchEvent(
        //     deviceModel: deviceModel, gestureName: gestureName, timestamp: timestamp
        // )

        case "sr_tpevt":
            // K900 touchpad event - convert to touch_event for frontend
            if let bodyObj = json["B"] as? [String: Any],
               let gestureType = bodyObj["type"] as? Int
            {
                if let gestureName = mapK900GestureType(gestureType) {
                    Bridge.log(
                        "LIVE: 👆 K900 touchpad event - Type: \(gestureType) -> \(gestureName)"
                    )
                    Bridge.sendTouchEvent(
                        deviceModel: "Mentra Live",
                        gestureName: gestureName,
                        timestamp: Int64(Date().timeIntervalSince1970 * 1000)
                    )
                } else {
                    Bridge.log("Unknown K900 gesture type: \(gestureType)")
                }
            }

        case "swipe_volume_status":
            let enabled = json["enabled"] as? Bool ?? false
            let timestamp = parseTimestamp(json["timestamp"])
            Bridge.sendSwipeVolumeStatus(enabled: enabled, timestamp: timestamp)

        case "switch_status":
            let switchType = (json["switch_type"] as? Int) ?? (json["switchType"] as? Int) ?? -1
            let switchValue = (json["switch_value"] as? Int) ?? (json["switchValue"] as? Int) ?? -1
            let timestamp = parseTimestamp(json["timestamp"])
            handleSwitchStatus(switchType: switchType, value: switchValue, timestamp: timestamp)

        case "rgb_led_control_response":
            let requestId = json["requestId"] as? String ?? ""
            let state = json["state"] as? String
            let success = state == "success" || json["success"] as? Bool == true
            let error = json["errorCode"] as? String ?? json["error"] as? String
            Bridge.sendRgbLedControlResponse(requestId: requestId, success: success, error: error)

        case "pong":
            Bridge.log("LIVE: Received pong response - connection healthy")

        case "imu_response", "imu_stream_response", "imu_gesture_response",
             "imu_gesture_subscribed", "imu_ack", "imu_error":
            // Handle IMU-related responses
            handleImuResponse(json)

        case "keep_alive_ack":
            emitKeepAliveAck(json)

        case "ble_photo_ready":
            processBlePhotoReady(json)

        case "ble_photo_complete":
            processBlePhotoComplete(json)

        case "file_announce":
            handleFileTransferAnnouncement(json)

        case "transfer_timeout":
            handleTransferTimeout(json)

        case "transfer_failed":
            handleTransferFailed(json)

        case "mtk_update_complete":
            Bridge.log("💾 Received MTK update complete from ASG client")

            let updateMessage =
                json["message"] as? String ?? "MTK firmware updated. Please restart glasses."
            let timestamp = parseTimestamp(json["timestamp"])

            Bridge.log("🔄 MTK Update Message: \(updateMessage)")

            // Send to React Native via Bridge
            Bridge.sendMtkUpdateComplete(message: updateMessage, timestamp: timestamp)

        case "ota_update_available":
            // Process OTA update available notification from glasses (background mode)
            Bridge.log("📱 Received ota_update_available from glasses")

            let versionCode = json["version_code"] as? Int64 ?? 0
            let versionName = json["version_name"] as? String ?? ""
            let totalSize = json["total_size"] as? Int64 ?? 0

            // Parse updates array
            var updates: [String] = []
            if let updatesArray = json["updates"] as? [String] {
                updates = updatesArray
            }

            Bridge.log(
                "📱 OTA available - version: \(versionName) (\(versionCode)), updates: \(updates), size: \(totalSize) bytes"
            )

            // Send to React Native
            Bridge.sendOtaUpdateAvailable(
                versionCode: versionCode,
                versionName: versionName,
                updates: updates,
                totalSize: totalSize
            )

        case "ota_start_ack":
            // Glasses acknowledged receipt of ota_start — phone can cancel its retry timer
            Bridge.log("LIVE: 📱 Received ota_start_ack from glasses")
            Bridge.sendOtaStartAck()

        case "ota_status":
            // Short keys (sid/ts/cs/st/sq/sp/op/err) are used by new firmware to keep BLE payload small.
            // Verbose keys (session_id/total_steps/…) are the fallback for older firmware.
            let osSessionId = json["sid"] as? String ?? json["session_id"] as? String ?? ""
            let osTotalSteps = json["ts"] as? Int ?? json["total_steps"] as? Int ?? 0
            let osCurrentStep = json["cs"] as? Int ?? json["current_step"] as? Int ?? 0
            let osStepType = json["st"] as? String ?? json["step_type"] as? String ?? "apk"
            let osPhase = json["phase"] as? String ?? "download"
            let osStepPercent = json["sp"] as? Int ?? json["step_percent"] as? Int ?? 0
            let osOverallPercent = json["op"] as? Int ?? json["overall_percent"] as? Int ?? 0
            let osStatus = json["status"] as? String ?? "idle"
            let osErrorMessage = json["err"] as? String ?? json["error_message"] as? String

            // If the glasses started a new session, drop any leftover state from the old
            // one before caching the new values. Without this, lastBesOtaProgress would
            // stay at e.g. 95 from the previous session and cause us to silently skip the
            // first few percent of the new BES install.
            if !osSessionId.isEmpty, let prevSid = cachedOtaSessionId, prevSid != osSessionId {
                resetOtaCache()
            }

            cachedOtaSessionId = osSessionId
            cachedOtaTotalSteps = osTotalSteps
            cachedOtaCurrentStep = osCurrentStep
            if let seq = json["sq"] as? [String] ?? json["step_sequence"] as? [String], !seq.isEmpty {
                cachedOtaStepSequence = seq
            }

            Bridge.log("LIVE: 📱 OTA status - step \(osCurrentStep)/\(osTotalSteps) \(osPhase) \(osStatus) \(osOverallPercent)%")

            let glassesTimeMs = (json["glasses_time_ms"] as? NSNumber)?.int64Value ?? 0
            Bridge.sendOtaStatus(
                sessionId: osSessionId,
                totalSteps: osTotalSteps,
                currentStep: osCurrentStep,
                stepType: osStepType,
                phase: osPhase,
                stepPercent: osStepPercent,
                overallPercent: osOverallPercent,
                status: osStatus,
                errorMessage: osErrorMessage,
                glassesTimeMs: glassesTimeMs > 0 ? glassesTimeMs : nil
            )

        case "ota_progress":
            // Legacy glasses firmware: map to unified ota_status (single RN path).
            let legacyStage = json["stage"] as? String ?? "download"
            let legacyStatus = json["status"] as? String ?? "PROGRESS"
            let legacyProgress = json["progress"] as? Int ?? 0
            let currentUpdate = json["current_update"] as? String ?? "apk"
            let err = json["error_message"] as? String
            let legacyPhase: String = legacyStage == "install" ? "install" : "download"
            let unified: String
            if legacyStatus == "FAILED" {
                unified = "failed"
            } else if legacyStatus == "FINISHED" {
                unified = "complete"
            } else {
                unified = "in_progress"
            }
            Bridge.log(
                "LIVE: 📱 Legacy ota_progress → ota_status: \(legacyStage) \(legacyStatus) \(legacyProgress)%"
            )
            Bridge.sendOtaStatus(
                sessionId: "",
                totalSteps: 1,
                currentStep: 1,
                stepType: currentUpdate,
                phase: legacyPhase,
                stepPercent: legacyProgress,
                overallPercent: legacyProgress,
                status: unified,
                errorMessage: err
            )

        default:
            // Flexible version_info parsing - handle any version_info* message
            if type.hasPrefix("version_info") {
                Bridge.log("LIVE: Received \(type): \(json)")

                // Extract all fields from JSON (except "type")
                var fields: [String: Any] = [:]
                for (key, value) in json {
                    if key != "type" {
                        fields[key] = value
                    }
                }

                // Update local fields for any we recognize
                if let appVersion = fields["app_version"] as? String {
                    DeviceStore.shared.apply("glasses", "appVersion", appVersion)
                }
                if let buildNumber = fields["build_number"] as? String {
                    isNewVersion = (Int(buildNumber) ?? 0) >= 5
                    DeviceStore.shared.apply("glasses", "buildNumber", buildNumber)
                }
                if let deviceModel = fields["device_model"] as? String {
                    DeviceStore.shared.apply("glasses", "deviceModel", deviceModel)
                }
                if let androidVersion = fields["android_version"] as? String {
                    DeviceStore.shared.apply("glasses", "androidVersion", androidVersion)
                }
                if let otaVersionUrl = fields["ota_version_url"] as? String {
                    DeviceStore.shared.apply("glasses", "otaVersionUrl", otaVersionUrl)
                }
                if let firmwareVersion = fields["firmware_version"] as? String {
                    DeviceStore.shared.apply("glasses", "firmwareVersion", firmwareVersion)
                }
                if let besFirmwareVersion = fields["bes_fw_version"] as? String {
                    DeviceStore.shared.apply("glasses", "besFirmwareVersion", besFirmwareVersion)
                }
                if let mtkFirmwareVersion = fields["mtk_fw_version"] as? String {
                    // MTK firmware version (e.g., "20241130")
                    // Note: Stored separately from BES version for OTA patch matching
                    DeviceStore.shared.apply("glasses", "mtkFirmwareVersion", mtkFirmwareVersion)
                }
                if let systemTimeMs = fields["system_time_ms"] as? NSNumber {
                    DeviceStore.shared.apply("glasses", "systemTimeMs", systemTimeMs.int64Value)
                }
                if let bluetoothMacAddress = fields["bt_mac_address"] as? String {
                    DeviceStore.shared.apply("glasses", "bluetoothMacAddress", bluetoothMacAddress)
                }
                if let systemTimeMs = fields["system_time_ms"] as? NSNumber {
                    DeviceStore.shared.apply("glasses", "systemTimeMs", systemTimeMs.int64Value)
                }

                Bridge.sendVersionInfo(fields)
            } else {
                Bridge.log("Unhandled message type: \(type)")
            }
        }
    }

    private func processChunkedJsonObject(_ json: [String: Any]) {
        guard let info = MessageChunker.getChunkInfo(json) else {
            Bridge.log("LIVE: Received malformed chunked message from glasses")
            return
        }

        guard let reassembled = incomingChunkReassembler.addChunk(info) else {
            return
        }

        guard let data = reassembled.data(using: .utf8),
              let reassembledJson = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            Bridge.log("LIVE: Failed to parse reassembled chunked message")
            return
        }

        processJsonObject(reassembledJson)
    }

    /// Maps K900 gesture type codes to gesture names
    /// Compute the weighted overall OTA percentage for a BES progress event arriving via sr_adota.
    /// Mirrors the weight table in OtaSessionManager.computeStepWeights() on the glasses side.
    ///
    /// Weight assignments:
    ///   [apk, mtk, bes] → bes base=50, weight=50
    ///   [apk, bes]       → bes base=20, weight=80
    ///   [mtk, bes]       → bes base=40, weight=60
    ///   [bes]            → bes base=0,  weight=100
    ///
    /// Drops cached OTA session context. Called when the glasses disconnect or when a new
    /// session id arrives — without this, stale fields from a previous session would leak
    /// into sr_adota progress messages (wrong totalSteps, wrong stepSequence, stale
    /// lastBesOtaProgress that swallows the first few percent of the new install).
    private func resetOtaCache() {
        cachedOtaSessionId = nil
        cachedOtaTotalSteps = 0
        cachedOtaCurrentStep = 0
        cachedOtaStepSequence = nil
        lastBesOtaProgress = -1
    }

    /// Falls back to raw besProgress when step sequence is unavailable.
    private func computeBesOverallPercent(besProgress: Int, stepSequence: [String]?) -> Int {
        guard let seq = stepSequence, !seq.isEmpty else { return besProgress }
        let hasApk = seq.contains("apk")
        let hasMtk = seq.contains("mtk")
        let base: Int
        let weight: Int
        if hasApk && hasMtk {
            base = 50; weight = 50
        } else if hasApk {
            base = 20; weight = 80
        } else if hasMtk {
            base = 40; weight = 60
        } else {
            base = 0; weight = 100
        }
        return min(100, base + besProgress * weight / 100)
    }

    private func mapK900GestureType(_ type: Int) -> String? {
        switch type {
        case 0: return "single_tap"
        case 1: return "double_tap"
        case 2: return "triple_tap"
        case 3: return "long_press"
        case 4: return "forward_swipe"
        case 5: return "backward_swipe"
        case 6: return "up_swipe"
        case 7: return "down_swipe"
        default: return nil
        }
    }

    private func processK900JsonMessage(_ json: [String: Any]) {
        guard let command = json["C"] as? String else { return }

        // Bridge.log("LIVE: Processing K900 command: \(command)")

        // convert command string (which is a json string) to a json object:
        let commandJson =
            try? JSONSerialization.jsonObject(with: command.data(using: .utf8)!) as? [String: Any]
        processJsonObject(commandJson ?? [:])

        if command.starts(with: "{") {
            return
        }

        switch command {
        case "sr_hrt":
            if let bodyObj = json["B"] as? [String: Any] {
                let readyResponse = bodyObj["ready"] as? Int ?? 0

                // Extract battery info from heartbeat
                let percentage = bodyObj["pt"] as? Int ?? 0
                let voltage = bodyObj["vt"] as? Int ?? 0
                let charging = (bodyObj["charg"] as? Int ?? 0) == 1

                // SOC is still booting
                if readyResponse == 0 {
                    Bridge.log("LIVE: K900 SOC not ready (ready=0)")
                    DeviceStore.shared.apply("glasses", "fullyBooted", false)
                    Bridge.sendTypedMessage("glasses_not_ready", body: [:])

                    // Check for low battery during pairing
                    if percentage > 0, percentage <= 20 {
                        Bridge.sendPairFailureEvent("errors:pairingBatteryTooLow")
                        return
                    }
                }

                // Update battery status if we have valid data
                if percentage > 0 {
                    updateBatteryStatus(level: percentage, isCharging: charging)
                    if voltage > 0 {
                        let voltageVolts = Double(voltage) / 1000.0
                        // Bridge.log(
                        //     "LIVE: Battery from heartbeat - \(percentage)%, \(voltageVolts)V, charging: \(charging)"
                        // )
                    }
                }

                if readyResponse == 1 {
                    Bridge.log("K900 SOC ready")
                    // Only send phone_ready if we haven't already established connection
                    // This prevents re-initialization on every heartbeat after initial connection
                    // The ready flag is reset on disconnect/reconnect, so this won't prevent proper reconnection
                    if !fullyBooted {
                        let readyMsg: [String: Any] = [
                            "type": "phone_ready",
                            "timestamp": Int64(Date().timeIntervalSince1970 * 1000),
                        ]
                        // Send it through our data channel
                        sendJson(readyMsg, wakeUp: true)
                    }
                }
            }

        case "sr_batv":
            if let body = json["B"] as? [String: Any],
               let voltage = body["vt"] as? Int,
               let percentage = body["pt"] as? Int
            {
                let voltageVolts = Double(voltage) / 1000.0
                let isCharging = voltage > 4000

                Bridge.log(
                    "🔋 K900 Battery Status - Voltage: \(voltageVolts)V, Level: \(percentage)%"
                )
                updateBatteryStatus(level: percentage, isCharging: isCharging)
            }

        case "sr_getvol":
            handleSrGetvol(json)

        case "sr_vol":
            handleSrVol(json)

        case "sr_vad":
            if let bodyObj = k900ParseBody(json["B"]),
               let on = k900JsonInt(bodyObj, "on"),
               on == 0 || on == 1
            {
                handleSpeakingStatus(speaking: on == 1)
            }

        case "sr_swit":
            if let body = k900ParseBody(json["B"]) {
                let switchType = k900JsonInt(body, "type") ?? -1
                let switchValue = k900JsonInt(body, "switch") ?? -1
                handleSwitchStatus(
                    switchType: switchType,
                    value: switchValue,
                    timestamp: Int64(Date().timeIntervalSince1970 * 1000)
                )
            }

        case "sr_shut":
            Bridge.log("K900 shutdown command received - glasses shutting down")
            // Mark as killed to prevent reconnection attempts
            // isKilled = true
            // // Clean disconnect without reconnection
            // if let peripheral = connectedPeripheral {
            //     Bridge.log("Disconnecting from glasses due to shutdown")
            //     centralManager?.cancelPeripheralConnection(peripheral)
            // }
            // Notify the system that glasses are intentionally disconnected
            updateConnectionState(ConnTypes.DISCONNECTED)

        case "sr_adota":
            // BES chip OTA progress — K900 path. Emit ota_status only (legacy ota_progress removed).
            if let bodyObj = json["B"] as? [String: Any] {
                let type = bodyObj["type"] as? String ?? ""
                let rawProgress = bodyObj["progress"] as? Int ?? 0

                // Round to nearest 5% for cleaner UI updates
                var progress = ((rawProgress + 2) / 5) * 5
                if progress > 100 { progress = 100 }

                // Only send if progress changed to a new 5% increment
                let isTerminalStatus = type == "success" || type == "error" || type == "fail"
                if progress == lastBesOtaProgress && !isTerminalStatus {
                    break // Skip duplicate progress
                }
                lastBesOtaProgress = progress

                Bridge.log(
                    "LIVE: 📱 BES OTA progress via sr_adota - type: \(type), raw: \(rawProgress)%, rounded: \(progress)%"
                )

                // Determine status and error message based on type
                var besOtaStatus: String
                var besOtaProgressVal: Int
                var besOtaErrorMessage: String? = nil

                // Order matters here: check completion (rawProgress >= 100 OR success) BEFORE
                // type=="update", because some BES firmware emits the final 100% tick with
                // type=="update" rather than type=="success". Treating that as PROGRESS would
                // leave the UI stuck at 100% forever.
                if type == "success" || rawProgress >= 100 {
                    besOtaStatus = "FINISHED"
                    besOtaProgressVal = 100
                    lastBesOtaProgress = -1 // Reset for next OTA
                } else if type == "error" || type == "fail" {
                    besOtaStatus = "FAILED"
                    besOtaProgressVal = progress
                    besOtaErrorMessage = bodyObj["message"] as? String ?? "BES update failed"
                    lastBesOtaProgress = -1 // Reset for next OTA
                } else if type == "update" {
                    besOtaStatus = "PROGRESS"
                    besOtaProgressVal = progress
                } else {
                    // Unknown type, treat as progress
                    besOtaStatus = "PROGRESS"
                    besOtaProgressVal = progress
                }

                let syntheticStatus: String
                if besOtaStatus == "FINISHED" {
                    syntheticStatus = "step_complete"
                } else if besOtaStatus == "FAILED" {
                    syntheticStatus = "failed"
                } else {
                    syntheticStatus = "in_progress"
                }
                let sid = cachedOtaSessionId ?? ""
                let totalSteps = cachedOtaTotalSteps > 0 ? cachedOtaTotalSteps : 1
                let currentStep = cachedOtaCurrentStep > 0 ? cachedOtaCurrentStep : 1
                let besOverallPercent = computeBesOverallPercent(besProgress: besOtaProgressVal, stepSequence: cachedOtaStepSequence)
                Bridge.sendOtaStatus(
                    sessionId: sid,
                    totalSteps: totalSteps,
                    currentStep: currentStep,
                    stepType: "bes",
                    phase: "install",
                    stepPercent: besOtaProgressVal,
                    overallPercent: besOverallPercent,
                    status: syntheticStatus,
                    errorMessage: besOtaErrorMessage
                )
            }

        case "sr_tpevt":
            // K900 touchpad event - convert to touch_event for frontend
            if let bodyObj = json["B"] as? [String: Any],
               let gestureType = bodyObj["type"] as? Int
            {
                if let gestureName = mapK900GestureType(gestureType) {
                    Bridge.log(
                        "LIVE: 👆 K900 touchpad event - Type: \(gestureType) -> \(gestureName)"
                    )
                    Bridge.sendTouchEvent(
                        deviceModel: deviceModel,
                        gestureName: gestureName,
                        timestamp: Int64(Date().timeIntervalSince1970 * 1000)
                    )
                } else {
                    Bridge.log("Unknown K900 gesture type: \(gestureType)")
                }
            }

        default:
            // Bridge.log("Unknown K900 command: \(command)")
            break
        }
    }

    // commands to send to the glasses:

    func requestWifiScan() {
        Bridge.log("LIVE: Requesting WiFi scan from glasses")
        let json: [String: Any] = ["type": "request_wifi_scan"]
        sendJson(json, wakeUp: true)
    }

    func sendWifiCredentials(_ ssid: String, _ password: String) {
        Bridge.log("LIVE: Sending WiFi credentials for SSID: \(ssid)")

        guard !ssid.isEmpty else {
            Bridge.log("LIVE: Cannot set WiFi credentials - SSID is empty")
            return
        }

        let json: [String: Any] = [
            "type": "set_wifi_credentials",
            "ssid": ssid,
            "password": password,
        ]

        sendJson(json, wakeUp: true)
    }

    func sendHotspotState(_ enabled: Bool) {
        Bridge.log("LIVE: 🔥 Sending hotspot state: \(enabled)")

        let json: [String: Any] = [
            "type": "set_hotspot_state",
            "enabled": enabled,
        ]

        sendJson(json, wakeUp: true)
    }

    func sendSetSystemTime(_ timestampMs: Int64) {
        Bridge.log("LIVE: ⏰ Sending set_system_time: \(timestampMs)")

        let json: [String: Any] = [
            "type": "set_system_time",
            "timestamp_ms": timestampMs,
        ]

        sendJson(json, wakeUp: true)
    }

    func sendUserEmailToGlasses(_ email: String) {
        Bridge.log("LIVE: Sending user email to glasses for crash reporting")

        guard !email.isEmpty else {
            Bridge.log("LIVE: Cannot send user email - email is empty")
            return
        }

        let json: [String: Any] = [
            "type": "user_email",
            "email": email,
        ]

        sendJson(json, wakeUp: true)
    }

    func sendIncidentId(_ incidentId: String, apiBaseUrl: String?) {
        var base = (apiBaseUrl ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if base.isEmpty {
            base = "https://api.mentra.glass"
        }
        while base.hasSuffix("/") {
            base = String(base.dropLast())
        }
        let bKey = MentraLive.incidentBleFileBase(incidentId: incidentId, prefix: "B")
        let lKey = MentraLive.incidentBleFileBase(incidentId: incidentId, prefix: "L")
        bleIncidentLogRelays[bKey] = BleIncidentLogRelayEntry(
            fileBaseKey: bKey, incidentId: incidentId, apiBaseUrl: base, kind: .firmware
        )
        bleIncidentLogRelays[lKey] = BleIncidentLogRelayEntry(
            fileBaseKey: lKey, incidentId: incidentId, apiBaseUrl: base, kind: .logcat
        )

        Bridge.log(
            "LIVE: Sending incidentId to glasses for log upload: \(incidentId) (BLE relay \(bKey), \(lKey))"
        )
        sendJson(["type": "upload_incident_logs", "incidentId": incidentId, "apiBaseUrl": base], wakeUp: true)
    }

    private static func incidentBleFileBase(incidentId: String, prefix: Character) -> String {
        var compact = incidentId.replacingOccurrences(of: "-", with: "").lowercased()
        if compact.count < 15 {
            compact += String(repeating: "0", count: 15 - compact.count)
        }
        return String(prefix) + String(compact.prefix(15))
    }

    func forgetWifiNetwork(_ ssid: String) {
        Bridge.log("LIVE: 📶 Sending WiFi forget command for SSID: \(ssid)")

        guard !ssid.isEmpty else {
            Bridge.log("LIVE: Cannot forget WiFi network - SSID is empty")
            return
        }

        let json: [String: Any] = [
            "type": "forget_wifi",
            "ssid": ssid,
        ]

        sendJson(json, wakeUp: true)
    }

    func queryGalleryStatus() {
        Bridge.log("LIVE: 📸 Querying gallery status from glasses")

        let json: [String: Any] = [
            "type": "query_gallery_status",
        ]

        sendJson(json, wakeUp: true)
    }

    func sendGalleryMode() {
        let active = DeviceStore.shared.get("bluetooth", "gallery_mode") as! Bool
        sendGalleryMode(requestId: nil, active: active)
    }

    func sendGalleryMode(requestId: String?, active: Bool) {
        Bridge.log("LIVE: 📸 Sending gallery mode active to glasses: \(active)")

        var json: [String: Any] = [
            "type": "save_in_gallery_mode",
            "active": active,
            "timestamp": Int(Date().timeIntervalSince1970 * 1000),
        ]
        if let requestId, !requestId.isEmpty {
            json["request_id"] = requestId
        }

        sendJson(json, wakeUp: true)
    }

    /// Send OTA start command to glasses.
    /// Called when user approves an update (onboarding or background mode).
    /// Triggers glasses to begin download and installation.
    func sendOtaStart(otaVersionUrl: String?) {
        Bridge.log("LIVE: 📱 Sending ota_start command to glasses")

        var json: [String: Any] = [
            "type": "ota_start",
            "timestamp": Int(Date().timeIntervalSince1970 * 1000),
        ]
        if let otaVersionUrl = otaVersionUrl?.trimmingCharacters(in: .whitespacesAndNewlines),
           !otaVersionUrl.isEmpty {
            json["ota_version_url"] = otaVersionUrl
        }

        sendJson(json, wakeUp: true)
    }

    func sendOtaQueryStatus() {
        Bridge.log("LIVE: 📱 Sending ota_query_status command to glasses")

        let json: [String: Any] = [
            "type": "ota_query_status",
            "timestamp": Int(Date().timeIntervalSince1970 * 1000),
        ]

        sendJson(json, wakeUp: true)
    }

    func sendOtaRetryVersionCheck() {
        Bridge.log("LIVE: ⏰ Sending ota_retry_version_check command to glasses")

        let json: [String: Any] = [
            "type": "ota_retry_version_check",
            "timestamp": Int(Date().timeIntervalSince1970 * 1000),
        ]

        sendJson(json, wakeUp: true)
    }

    func keepAwake() {
        Bridge.log("LIVE: 📱 Sending keep_awake command to glasses")

        let json: [String: Any] = [
            "type": "keep_awake",
            "timestamp": Int(Date().timeIntervalSince1970 * 1000),
        ]

        sendJson(json, wakeUp: true)
    }

    // MARK: - Message Handlers

    private func handleGlassesReady() {
        Bridge.log("LIVE: 🎉 Received glasses_ready message - SOC is booted and ready!")

        stopReadinessCheckLoop()
        sendBleMtuConfig()

        // Invalidate any version fields from a prior link session so the next version_info
        // cannot leave a stale build number in RN (ASG is source of truth for PackageInfo).
        DeviceStore.shared.apply("glasses", "buildNumber", "")
        DeviceStore.shared.apply("glasses", "appVersion", "")
        DeviceStore.shared.apply("glasses", "besFirmwareVersion", "")
        DeviceStore.shared.apply("glasses", "mtkFirmwareVersion", "")
        Bridge.log("LIVE: Cleared cached version_info fields before refresh")

        // Perform SOC-dependent initialization
        requestBatteryStatus()
        requestWifiStatus()
        requestVersionInfo()
        sendCoreTokenToAsgClient()
        sendStoredUserEmailToAsgClient()

        // Send user settings to glasses
        sendUserSettings()

        // Claim LED control and enable gesture reporting
        sendRgbLedControlAuthority(true)
        setTouchEventReporting(true)
        setSwipeVolumeControl(false)

        // Start heartbeat
        startHeartbeat()

        // Restore mic state if it was enabled before reconnect
        if micIntentEnabled {
            if BLOCK_AUDIO_DUPLEX, let monitor = phoneAudioMonitor, monitor.isPlaying() {
                micSuspendedForAudio = true
                Bridge.log(
                    "LIVE: 🎤 Restoring mic intent after reconnect, but phone audio is playing - suspending"
                )
            } else {
                micSuspendedForAudio = false
                Bridge.log("LIVE: 🎤 Restoring mic state after reconnect")
                startMicBeat()
            }
        }

        fullyBooted = true
        connected = true
        updateConnectionState(ConnTypes.CONNECTED)
    }

    private func handleWifiScanResult(_ json: [String: Any]) {
        var networks: [[String: Any]] = []

        // First, check for enhanced format (networks_neo)
        if let networksNeoArray = json["networks_neo"] as? [[String: Any]] {
            networks = networksNeoArray
        }

        let scanComplete = json["scan_complete"] as? Bool ?? json["scanComplete"] as? Bool ?? false
        Bridge.updateWifiScanResults(networks, scanComplete: scanComplete)
    }

    private func handleButtonPress(_ json: [String: Any]) {
        let buttonId = json["buttonId"] as? String ?? "unknown"
        let pressType = json["pressType"] as? String ?? "short"

        Bridge.log("LIVE: Received button press - buttonId: \(buttonId), pressType: \(pressType)")
        Bridge.sendButtonPress(buttonId: buttonId, pressType: pressType)
    }

    private func handleVersionInfo(_ json: [String: Any]) {
        let appVersion = json["app_version"] as? String ?? ""
        let buildNumber = json["build_number"] as? String ?? ""
        let deviceModel = json["device_model"] as? String ?? ""
        let androidVersion = json["android_version"] as? String ?? ""
        let otaVersionUrl = json["ota_version_url"] as? String ?? ""
        let firmwareVersion = json["firmware_version"] as? String ?? ""
        let bluetoothMacAddress = json["bt_mac_address"] as? String ?? ""

        DeviceStore.shared.apply("glasses", "appVersion", appVersion)
        DeviceStore.shared.apply("glasses", "buildNumber", buildNumber)
        DeviceStore.shared.apply("glasses", "otaVersionUrl", otaVersionUrl)
        DeviceStore.shared.apply("glasses", "firmwareVersion", firmwareVersion)
        DeviceStore.shared.apply("glasses", "bluetoothMacAddress", bluetoothMacAddress)
        isNewVersion = (Int(buildNumber) ?? 0) >= 5
        DeviceStore.shared.apply("glasses", "deviceModel", deviceModel)
        DeviceStore.shared.apply("glasses", "androidVersion", androidVersion)

        // Detect LC3 audio support: K901+ devices have microphone, K900 does not
        // supportsLC3Audio = deviceModel != "K900"
        // hasMic = supportsLC3Audio

        Bridge.log(
            "Glasses Version - App: \(appVersion), Build: \(buildNumber), Device: \(deviceModel), Android: \(androidVersion), Firmware: \(firmwareVersion), BT MAC: \(bluetoothMacAddress), OTA URL: \(otaVersionUrl)"
        )
        Bridge.log("LIVE: LC3 Audio Support: \(supportsLC3Audio), Has Mic: \(hasMic)")
        emitVersionInfo(
            appVersion: appVersion, buildNumber: buildNumber, deviceModel: deviceModel,
            androidVersion: androidVersion, otaVersionUrl: otaVersionUrl,
            firmwareVersion: firmwareVersion,
            bluetoothMacAddress: bluetoothMacAddress
        )
    }

    private func handleAck(_: [String: Any]) {
        Bridge.log("LIVE: Received ack")
        //    let messageId = json["mId"] as? Int ?? 0
        //    if let pendingMessage = pending, pendingMessage.id == messageId {
        //      pending = nil
        //    }
    }

    // MARK: - LC3 Audio Processing

    /// Process LC3 audio packet received from glasses microphone
    /// Packet format: [0xF1, sequenceNumber, lc3Data...]
    private func processLc3AudioPacket(_ data: Data) {
        guard data.count >= 2 else {
            Bridge.log("LIVE: Invalid LC3 audio packet: too short (\(data.count) bytes)")
            return
        }

        // Check for 0xF1 audio header (same as Android)
        guard data[0] == 0xF1 else {
            Bridge.log("LIVE: Invalid LC3 packet header: 0x\(String(format: "%02X", data[0]))")
            return
        }

        let sequenceNumber = Int8(bitPattern: data[1])
        let lc3Data = data.subdata(in: 2 ..< data.count)

        // Validate sequence number for packet loss detection
        if lastReceivedLc3Sequence != -1 && (lastReceivedLc3Sequence &+ 1) != sequenceNumber {
            Bridge.log(
                "LIVE: LC3 packet sequence mismatch. Expected: \(lastReceivedLc3Sequence &+ 1), Got: \(sequenceNumber)"
            )
        }
        lastReceivedLc3Sequence = sequenceNumber

        // // Decode LC3 to PCM using existing PcmConverter
        // let pcmConverter = PcmConverter()
        // guard let pcmData = pcmConverter.decode(lc3Data) as? Data, pcmData.count > 0 else {
        //     Bridge.log("LIVE: Failed to decode LC3 data to PCM")
        //     return
        // }

        // // Forward PCM data to DeviceManager for audio events and server transmission (same as Android)
        // DeviceManager.shared.handlePcm(pcmData)

        // Bridge.log(
        //     "LIVE: Processed LC3 audio seq=\(sequenceNumber), \(lc3Data.count) bytes"
        // )
        DeviceManager.shared.handleGlassesMicData(lc3Data, 40)

        // Bridge.log(
        //     "LIVE: Processed LC3 audio seq=\(sequenceNumber), \(lc3Data.count)→\(pcmData.count) bytes"
        // )
    }

    // MARK: - BLE Photo Transfer Handlers

    private func processBlePhotoReady(_ json: [String: Any]) {
        let bleImgId = json["bleImgId"] as? String ?? ""
        let requestId = json["requestId"] as? String ?? ""
        let compressionDurationMs = json["compressionDurationMs"] as? Int64 ?? 0

        Bridge.log(
            "LIVE: 📸 BLE photo ready notification: bleImgId=\(bleImgId), requestId=\(requestId)"
        )

        // Update the transfer with glasses compression duration
        if var transfer = blePhotoTransfers[bleImgId] {
            transfer.glassesCompressionDurationMs = compressionDurationMs
            transfer.bleTransferStartTime = Date() // BLE transfer starts now
            blePhotoTransfers[bleImgId] = transfer
            Bridge.log("LIVE: ⏱️ Glasses compression took: \(compressionDurationMs)ms")
        } else {
            Bridge.log("LIVE: Received ble_photo_ready for unknown transfer: \(bleImgId)")
        }
    }

    private func processBlePhotoComplete(_ json: [String: Any]) {
        let bleRequestId = json["requestId"] as? String ?? ""
        let bleBleImgId = json["bleImgId"] as? String ?? ""
        let bleSuccess = json["success"] as? Bool ?? false

        Bridge.log(
            "LIVE: BLE photo transfer complete - requestId: \(bleRequestId), bleImgId: \(bleBleImgId), success: \(bleSuccess)"
        )

        // Send completion notification back to glasses using unified transfer_complete
        if bleSuccess {
            sendTransferCompleteConfirmation(fileName: bleBleImgId, success: true)
        } else {
            Bridge.log("LIVE: BLE photo transfer failed for requestId: \(bleRequestId)")
            sendTransferCompleteConfirmation(fileName: bleBleImgId, success: false)
        }
    }

    private func handleFileTransferAnnouncement(_ json: [String: Any]) {
        let fileName = json["fileName"] as? String ?? ""
        let totalPackets = json["totalPackets"] as? Int ?? 0
        let fileSize = json["fileSize"] as? Int ?? 0

        guard !fileName.isEmpty, totalPackets > 0 else {
            Bridge.log("LIVE: 📢 Invalid file transfer announcement: \(json)")
            return
        }

        Bridge.log(
            "LIVE: 📢 File transfer announcement: \(fileName), \(totalPackets) packets, \(fileSize) bytes"
        )

        if var existing = activeFileTransfers[fileName] {
            Bridge.log("LIVE: 📢 Restart detected - clearing existing session for \(fileName)")
            Bridge.log(
                "LIVE: 📊 Previous session had \(existing.receivedPackets.count)/\(existing.totalPackets) packets"
            )
            activeFileTransfers.removeValue(forKey: fileName)
        }

        var session = FileTransferSession(
            fileName: fileName, fileSize: fileSize, announcedPackets: totalPackets
        )
        session.isAnnounced = true
        activeFileTransfers[fileName] = session

        let bleImgId = fileName.split(separator: ".").first.map(String.init) ?? ""
        if var bleTransfer = blePhotoTransfers[bleImgId] {
            var bleSession =
                bleTransfer.session
                    ?? FileTransferSession(
                        fileName: fileName, fileSize: fileSize, announcedPackets: totalPackets
                    )
            bleSession.updateAnnouncedPackets(totalPackets)
            bleTransfer.session = bleSession
            blePhotoTransfers[bleImgId] = bleTransfer
        }
    }

    private func handleTransferTimeout(_ json: [String: Any]) {
        let fileName = json["fileName"] as? String ?? ""
        guard !fileName.isEmpty else {
            Bridge.log("LIVE: ⏰ Transfer timeout notification missing fileName: \(json)")
            return
        }

        Bridge.log("LIVE: ⏰ Transfer timeout for: \(fileName)")

        activeFileTransfers.removeValue(forKey: fileName)

        let bleImgId = fileName.split(separator: ".").first.map(String.init) ?? ""
        if let transfer = blePhotoTransfers.removeValue(forKey: bleImgId) {
            Bridge.log("LIVE: 🧹 Cleaned up timed out BLE photo transfer for: \(bleImgId)")
            Bridge.sendPhotoError(
                requestId: transfer.requestId, errorCode: "TRANSFER_TIMEOUT",
                errorMessage: "Transfer timed out for: \(fileName)"
            )
        }
        if bleIncidentLogRelays.removeValue(forKey: bleImgId) != nil {
            Bridge.log("LIVE: 🧹 Cleaned up timed out BLE incident log relay for: \(bleImgId)")
        }
    }

    private func handleTransferFailed(_ json: [String: Any]) {
        let fileName = json["fileName"] as? String ?? ""
        let reason = json["reason"] as? String ?? "unknown"
        let requestId = json["requestId"] as? String ?? ""

        guard !fileName.isEmpty else {
            Bridge.log("LIVE: ❌ Transfer failed notification missing fileName: \(json)")
            Bridge.sendPhotoError(
                requestId: requestId, errorCode: "FILE_NAME_MISSING",
                errorMessage: "Transfer failed fileName is missing"
            )
            return
        }

        Bridge.log("LIVE: ❌ Transfer failed for: \(fileName) (reason: \(reason))")
        let bleImgId = fileName.split(separator: ".").first.map(String.init) ?? ""
        let transfer = blePhotoTransfers[bleImgId]
        let effectiveRequestId = requestId.isEmpty ? transfer?.requestId ?? "" : requestId
        Bridge.sendPhotoError(
            requestId: effectiveRequestId, errorCode: "TRANSFER_FAILED",
            errorMessage: "Transfer failed for: \(fileName) (reason: \(reason))"
        )

        if let session = activeFileTransfers.removeValue(forKey: fileName) {
            Bridge.log(
                "LIVE: 📊 Transfer stats - Received: \(session.receivedPackets.count)/\(session.totalPackets) packets"
            )
        }

        if let transfer = blePhotoTransfers.removeValue(forKey: bleImgId) {
            Bridge.log(
                "LIVE: 🧹 Cleaned up failed BLE photo transfer for: \(bleImgId) (requestId: \(transfer.requestId))"
            )
        }
        if bleIncidentLogRelays.removeValue(forKey: bleImgId) != nil {
            Bridge.log("LIVE: 🧹 Cleaned up failed BLE incident log relay for: \(bleImgId)")
        }
    }

    // requestMissingPackets() removed - no longer used with ACK system
    // Phone now sends transfer_complete with success=false to trigger full retry

    // MARK: - File Transfer Processing

    private func processFilePacket(_ packetInfo: K900ProtocolUtils.FilePacketInfo) {
        //    Bridge.log("📦 Processing file packet: \(packetInfo.fileName) [\(packetInfo.packIndex)/\(((packetInfo.fileSize + K900ProtocolUtils.FILE_PACK_SIZE - 1) / K900ProtocolUtils.FILE_PACK_SIZE - 1))] (\(packetInfo.packSize) bytes)")

        // Check if this is a BLE photo transfer we're tracking
        var bleImgId = packetInfo.fileName
        if let dotIndex = bleImgId.lastIndex(of: ".") {
            bleImgId = String(bleImgId[..<dotIndex])
        }

        if let incidentRelay = bleIncidentLogRelays[bleImgId] {
            Bridge.log("LIVE: 📦 BLE incident log relay packet for: \(bleImgId)")

            if incidentRelay.session == nil {
                activeFileTransfers.removeValue(forKey: packetInfo.fileName)
                var session = FileTransferSession(
                    fileName: packetInfo.fileName, fileSize: Int(packetInfo.fileSize)
                )
                session.recalculateTotalPackets(actualPackSize: Int(packetInfo.packSize))
                incidentRelay.session = session
                Bridge.log(
                    "LIVE: 📦 Started BLE incident log transfer: \(packetInfo.fileName) (\(packetInfo.fileSize) bytes, \(session.totalPackets) packets)"
                )
            }

            guard var session = incidentRelay.session else { return }

            let added = session.addPacket(Int(packetInfo.packIndex), data: packetInfo.data)
            incidentRelay.session = session

            if added {
                if session.isComplete {
                    if let payload = session.assembleFile() {
                        uploadBleIncidentLogRelay(
                            relay: incidentRelay, fileName: packetInfo.fileName, data: payload
                        )
                    } else {
                        sendTransferCompleteConfirmation(fileName: packetInfo.fileName, success: false)
                        // Keep relay entry for glasses retry after transfer_complete:false.
                        incidentRelay.session = nil
                    }
                } else if session.isFinalPacket(Int(packetInfo.packIndex)) {
                    let missing = session.missingPacketIndices()
                    if !missing.isEmpty {
                        Bridge.log(
                            "LIVE: ❌ BLE incident log transfer incomplete. Missing \(missing.count) packets"
                        )
                        sendTransferCompleteConfirmation(fileName: packetInfo.fileName, success: false)
                        // Keep relay entry for glasses retry after transfer_complete:false.
                        incidentRelay.session = nil
                    }
                }
            }

            return
        }

        if bleImgId.hasPrefix("B") || bleImgId.hasPrefix("L") {}

        if var photoTransfer = blePhotoTransfers[bleImgId] {
            // This is a BLE photo transfer
            Bridge.log("📦 BLE photo transfer packet for requestId: \(photoTransfer.requestId)")

            // Get or create session for this transfer
            if photoTransfer.session == nil {
                var session = FileTransferSession(
                    fileName: packetInfo.fileName,
                    fileSize: Int(packetInfo.fileSize)
                )
                photoTransfer.session = session
                blePhotoTransfers[bleImgId] = photoTransfer
                Bridge.log(
                    "📦 Started BLE photo transfer: \(packetInfo.fileName) (\(packetInfo.fileSize) bytes, \(session.totalPackets) packets)"
                )
            }

            // Add packet to session
            if var session = photoTransfer.session {
                let added = session.addPacket(Int(packetInfo.packIndex), data: packetInfo.data)
                photoTransfer.session = session
                blePhotoTransfers[bleImgId] = photoTransfer

                if added {
                    if session.isComplete {
                        let transferEndTime = Date()
                        let totalDuration =
                            transferEndTime.timeIntervalSince(photoTransfer.phoneStartTime) * 1000
                        let bleTransferDuration =
                            photoTransfer.bleTransferStartTime != nil
                                ? transferEndTime.timeIntervalSince(photoTransfer.bleTransferStartTime!)
                                * 1000 : 0

                        Bridge.log("✅ BLE photo transfer complete: \(packetInfo.fileName)")
                        Bridge.log(
                            "⏱️ Total duration (request to complete): \(Int(totalDuration))ms"
                        )
                        Bridge.log(
                            "⏱️ Glasses compression: \(photoTransfer.glassesCompressionDurationMs)ms"
                        )
                        if bleTransferDuration > 0 {
                            Bridge.log("⏱️ BLE transfer duration: \(Int(bleTransferDuration))ms")
                            Bridge.log(
                                "📊 Transfer rate: \(Int(packetInfo.fileSize) * 1000 / Int(bleTransferDuration)) bytes/sec"
                            )
                        }

                        if let imageData = session.assembleFile() {
                            processAndUploadBlePhoto(photoTransfer, imageData: imageData)
                        }

                        sendTransferCompleteConfirmation(
                            fileName: packetInfo.fileName, success: true
                        )
                        blePhotoTransfers.removeValue(forKey: bleImgId)
                    } else if session.isFinalPacket(Int(packetInfo.packIndex)) {
                        let missingPackets = session.missingPacketIndices()
                        if !missingPackets.isEmpty {
                            Bridge.log(
                                "❌ BLE photo transfer incomplete after final packet. Missing \(missingPackets.count) packets: \(missingPackets)"
                            )
                            Bridge.log("❌ Telling glasses to retry entire transfer")

                            // Tell glasses transfer failed, they will retry. Keep the photo
                            // transfer entry so the retry maps back to the original requestId.
                            sendTransferCompleteConfirmation(
                                fileName: packetInfo.fileName, success: false
                            )
                            photoTransfer.session = nil
                            blePhotoTransfers[bleImgId] = photoTransfer
                        }
                    }
                }
            }

            return
        }

        // Regular file transfer (not a BLE photo)
        var session = activeFileTransfers[packetInfo.fileName]
        if session == nil {
            // New file transfer
            session = FileTransferSession(
                fileName: packetInfo.fileName, fileSize: Int(packetInfo.fileSize)
            )
            activeFileTransfers[packetInfo.fileName] = session

            Bridge.log(
                "LIVE: 📦 Started new file transfer: \(packetInfo.fileName) (\(packetInfo.fileSize) bytes, \(session!.totalPackets) packets)"
            )
        }

        // Add packet to session
        if var sess = session {
            let added = sess.addPacket(Int(packetInfo.packIndex), data: packetInfo.data)
            activeFileTransfers[packetInfo.fileName] = sess

            if added {
                Bridge.log(
                    "LIVE: 📦 Packet \(packetInfo.packIndex) received successfully (BES will auto-ACK)"
                )

                if sess.isComplete {
                    Bridge.log("LIVE: 📦 File transfer complete: \(packetInfo.fileName)")

                    if let fileData = sess.assembleFile() {
                        saveReceivedFile(
                            fileName: packetInfo.fileName, fileData: fileData,
                            fileType: packetInfo.fileType
                        )
                    }

                    sendTransferCompleteConfirmation(fileName: packetInfo.fileName, success: true)
                    activeFileTransfers.removeValue(forKey: packetInfo.fileName)
                } else if sess.isFinalPacket(Int(packetInfo.packIndex)) {
                    let missingPackets = sess.missingPacketIndices()
                    if !missingPackets.isEmpty {
                        Bridge.log(
                            "LIVE: ❌ File transfer incomplete after final packet. Missing \(missingPackets.count) packets: \(missingPackets)"
                        )
                        Bridge.log("LIVE: ❌ Telling glasses to retry entire transfer")

                        // Tell glasses transfer failed, they will retry
                        sendTransferCompleteConfirmation(
                            fileName: packetInfo.fileName, success: false
                        )
                        activeFileTransfers.removeValue(forKey: packetInfo.fileName)
                    }
                }
            } else {
                Bridge.log("LIVE: 📦 Duplicate or invalid packet: \(packetInfo.packIndex)")
            }
        }
    }

    private func saveReceivedFile(fileName: String, fileData: Data, fileType: UInt8) {
        do {
            // Get or create the directory for saving files
            let documentsDirectory = FileManager.default.urls(
                for: .documentDirectory, in: .userDomainMask
            ).first!
            let saveDirectory = documentsDirectory.appendingPathComponent(FILE_SAVE_DIR)

            if !FileManager.default.fileExists(atPath: saveDirectory.path) {
                try FileManager.default.createDirectory(
                    at: saveDirectory, withIntermediateDirectories: true
                )
            }

            // Generate unique filename with timestamp
            let dateFormatter = DateFormatter()
            dateFormatter.dateFormat = "yyyyMMdd_HHmmss"
            let timestamp = dateFormatter.string(from: Date())

            // Determine file extension based on type
            var fileExtension = ""
            switch fileType {
            case K900ProtocolUtils.CMD_TYPE_PHOTO:
                // For photos, try to preserve the original extension
                if let dotIndex = fileName.lastIndex(of: ".") {
                    fileExtension = String(fileName[dotIndex...])
                } else {
                    fileExtension = ".jpg" // Default to JPEG if no extension
                }
            case K900ProtocolUtils.CMD_TYPE_VIDEO:
                fileExtension = ".mp4"
            case K900ProtocolUtils.CMD_TYPE_AUDIO:
                fileExtension = ".wav"
            default:
                // Try to get extension from original filename
                if let dotIndex = fileName.lastIndex(of: ".") {
                    fileExtension = String(fileName[dotIndex...])
                }
            }

            // Create unique filename
            var baseFileName = fileName
            if let dotIndex = baseFileName.lastIndex(of: ".") {
                baseFileName = String(baseFileName[..<dotIndex])
            }
            let uniqueFileName = "\(baseFileName)_\(timestamp)\(fileExtension)"

            // Save the file
            let fileURL = saveDirectory.appendingPathComponent(uniqueFileName)
            try fileData.write(to: fileURL)

            Bridge.log("LIVE: 💾 Saved file: \(fileURL.path)")

            // Notify about the received file
            notifyFileReceived(filePath: fileURL.path, fileType: fileType)

        } catch {
            Bridge.log("LIVE: Error saving received file: \(fileName), error: \(error)")
        }
    }

    private func notifyFileReceived(filePath: String, fileType: UInt8) {
        // Create event based on file type
        let event: [String: Any] = [
            "type": "file_received",
            "filePath": filePath,
            "fileType": String(format: "0x%02X", fileType),
            "timestamp": Int64(Date().timeIntervalSince1970 * 1000),
        ]
    }

    private func uploadBleIncidentLogRelay(
        relay: BleIncidentLogRelayEntry, fileName: String, data: Data
    ) {
        let token = DeviceStore.shared.get("bluetooth", "core_token") as? String ?? ""
        guard !token.isEmpty else {
            sendTransferCompleteConfirmation(fileName: fileName, success: false)
            if let existing = bleIncidentLogRelays[relay.fileBaseKey] {
                existing.session = nil
            }
            return
        }

        guard var components = URLComponents(string: relay.apiBaseUrl) else {
            sendTransferCompleteConfirmation(fileName: fileName, success: false)
            if let existing = bleIncidentLogRelays[relay.fileBaseKey] {
                existing.session = nil
            }
            return
        }
        let basePath = components.path.hasSuffix("/")
            ? String(components.path.dropLast())
            : components.path
        components.path = basePath + "/api/incidents/\(relay.incidentId)/logs"
        guard let url = components.url else {
            sendTransferCompleteConfirmation(fileName: fileName, success: false)
            if let existing = bleIncidentLogRelays[relay.fileBaseKey] {
                existing.session = nil
            }
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = data

        URLSession.shared.dataTask(with: request) { _, response, error in
            let ok: Bool
            let statusCode: Int?
            if error != nil {
                ok = false
                statusCode = nil
            } else if let http = response as? HTTPURLResponse {
                ok = (200 ..< 300).contains(http.statusCode)
                statusCode = http.statusCode
            } else {
                ok = false
                statusCode = nil
            }
            DispatchQueue.main.async {
                if ok {
                    Bridge.log("LIVE: ✅ Incident log BLE relay uploaded (\(relay.kind))")
                    self.bleIncidentLogRelays.removeValue(forKey: relay.fileBaseKey)
                } else if let existing = self.bleIncidentLogRelays[relay.fileBaseKey] {
                    // Keep relay entry for glasses retry after transfer_complete:false.
                    existing.session = nil
                }
                self.sendTransferCompleteConfirmation(fileName: fileName, success: ok)
            }
        }.resume()
    }

    private func processAndUploadBlePhoto(_ transfer: BlePhotoTransfer, imageData: Data) {
        Bridge.log("LIVE: Processing BLE photo for upload. RequestId: \(transfer.requestId)")

        BlePhotoUploadService.processAndUploadPhoto(
            imageData: imageData, requestId: transfer.requestId, webhookUrl: transfer.webhookUrl,
            authToken: transfer.authToken
        ) { [weak self] requestId, responseBody in
            self?.sendPhotoTerminalSuccessResponse(
                requestId: requestId,
                uploadUrl: transfer.webhookUrl,
                responseBody: responseBody
            )
        } onError: { requestId, error in
            Bridge.sendPhotoError(
                requestId: requestId,
                errorCode: "PHONE_UPLOAD_FAILED",
                errorMessage: "BLE photo upload failed: \(error)"
            )
        }
    }

    private func sendPhotoTerminalSuccessResponse(
        requestId: String,
        uploadUrl: String,
        responseBody: String
    ) {
        var event: [String: Any] = [
            "type": "photo_response",
            "state": "success",
            "success": true,
            "requestId": requestId,
            "uploadUrl": uploadUrl,
            "timestamp": Int(Date().timeIntervalSince1970 * 1000),
        ]
        copyPhotoUploadResponseMetadata(into: &event, responseBody: responseBody)
        Bridge.sendPhotoResponse(event)
    }

    private func copyPhotoUploadResponseMetadata(
        into event: inout [String: Any],
        responseBody: String
    ) {
        guard !responseBody.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            let data = responseBody.data(using: .utf8),
            let response = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            return
        }
        for key in ["photoUrl", "statusUrl", "mimeType", "contentType", "bytes", "size"] {
            if let value = response[key], !(value is NSNull) {
                event[key] = value
            }
        }
    }

    private func sendAckToGlasses(messageId: Int) {
        let json: [String: Any] = [
            "type": "msg_ack",
            "mId": messageId,
            "timestamp": Int64(Date().timeIntervalSince1970 * 1000),
        ]

        sendJson(json, requireAck: false)
    }

    private func sendTransferCompleteConfirmation(fileName: String, success: Bool) {
        let json: [String: Any] = [
            "type": "transfer_complete",
            "fileName": fileName,
            "success": success,
            "timestamp": Int64(Date().timeIntervalSince1970 * 1000),
        ]

        sendJson(json, wakeUp: true)
        Bridge.log(
            "\(success ? "✅" : "❌") Sent transfer completion confirmation for: \(fileName) (success: \(success))"
        )
    }

    private func sendBleMtuConfig() {
        let effectiveMtu = min(currentMtu, bes2700MtuLimit)
        let json: [String: Any] = [
            "type": "set_ble_mtu",
            "mtu": effectiveMtu,
            "timestamp": Int64(Date().timeIntervalSince1970 * 1000),
        ]

        sendJson(json)
        Bridge.log(
            "LIVE: Sent BLE MTU config to glasses: negotiated=\(currentMtu), BES2700 limit=\(bes2700MtuLimit), effective=\(effectiveMtu)"
        )
    }

    // MARK: - Sending Data

    func queueSend(_ data: Data, id: String) {
        Task {
            await commandQueue.enqueue(PendingMessage(data: data, id: id, retries: 0))
        }
    }

    func sendJson(_ jsonOriginal: [String: Any], wakeUp: Bool = false, requireAck: Bool = true) {
        do {
            var json = jsonOriginal
            var messageId: Int64 = -1
            var trackingId = "-1" // -1 means no ACK tracking needed

            if isNewVersion, requireAck {
                messageId = Int64(globalMessageId)
                json["mId"] = globalMessageId
                trackingId = String(globalMessageId)
                globalMessageId += 1
            }

            let jsonData = try JSONSerialization.data(withJSONObject: json)
            if let jsonString = String(data: jsonData, encoding: .utf8) {
                // First check if the message needs chunking
                // Create a test C-wrapped version to check size
                var testWrapper: [String: Any] = [K900ProtocolUtils.FIELD_C: jsonString]
                if wakeUp {
                    testWrapper["W"] = 1
                }
                let testData = try JSONSerialization.data(withJSONObject: testWrapper)
                let testWrappedJson = String(data: testData, encoding: .utf8) ?? ""

                // Check if chunking is needed
                if MessageChunker.needsChunking(testWrappedJson) {
                    Bridge.log("LIVE: Message exceeds threshold, chunking required")

                    // Create chunks
                    let chunks = MessageChunker.createChunks(
                        originalJson: jsonString, messageId: messageId, wakeUp: wakeUp
                    )
                    guard !chunks.isEmpty else {
                        Bridge.log("LIVE: Failed to create BLE chunks within K900 packet limit")
                        return
                    }
                    Bridge.log("LIVE: Sending \(chunks.count) chunks")

                    // Send each chunk
                    for (index, chunk) in chunks.enumerated() {
                        let chunkData = try JSONSerialization.data(withJSONObject: chunk)
                        if let chunkStr = String(data: chunkData, encoding: .utf8) {
                            // Pack each chunk using the normal K900 protocol
                            let packedData =
                                packJson(chunkStr, wakeUp: wakeUp && index == 0) ?? Data() // Only wakeup on first chunk

                            // Queue the chunk for sending
                            // Only track ACK for the final chunk (which has the mId)
                            // All other chunks get "-1" (no ACK tracking)
                            let isFinalChunk = (index == chunks.count - 1)
                            let chunkTrackingId = (requireAck && isFinalChunk) ? trackingId : "-1"
                            queueSend(packedData, id: chunkTrackingId)

                            // Add small delay between chunks to avoid overwhelming the connection
                            if index < chunks.count - 1 {
                                Thread.sleep(forTimeInterval: 0.05) // 50ms delay between chunks
                            }
                        }
                    }

                    Bridge.log("LIVE: All chunks queued for transmission")
                } else {
                    // Normal single message transmission
                    if (json["type"] as? String) == "take_photo" {
                        Bridge.log("LIVE: PHOTO PIPELINE BLE handoff — sendJson -> queueSend take_photo")
                    }
                    Bridge.log("LIVE: Sending data to glasses: \(jsonString)")
                    let packedData = packJson(jsonString, wakeUp: wakeUp) ?? Data()
                    queueSend(packedData, id: trackingId)
                }
            }
        } catch {
            Bridge.log("LIVE: Error creating JSON: \(error)")
        }
    }

    // MARK: - Status Requests

    private func requestBatteryStatus() {
        // cs_batv is a K900 protocol command handled directly by BES2700
        // It doesn't go through MTK Android, so it doesn't use ACK system
        let command: [String: Any] = [
            "C": "cs_batv",
            "V": 1,
            "B": "",
        ]

        if sendRawK900Command(command) {
            Bridge.log("LIVE: Sent cs_batv via queue (BES-handled command)")
        } else {
            Bridge.log("LIVE: Failed to send battery request")
        }
    }

    private func requestWifiStatus() {
        let json: [String: Any] = ["type": "request_wifi_status"]
        sendJson(json, wakeUp: true)
    }

    func requestVersionInfo() {
        let json: [String: Any] = ["type": "request_version"]
        sendJson(json)
    }

    private func sendCoreTokenToAsgClient() {
        Bridge.log("Preparing to send coreToken to ASG client")

        let coreToken = DeviceStore.shared.get("bluetooth", "core_token") as? String ?? ""
        if coreToken.isEmpty {
            Bridge.log("LIVE: No coreToken available to send to ASG client")
            return
        }

        let json: [String: Any] = [
            "type": "auth_token",
            "coreToken": coreToken,
            "timestamp": Int64(Date().timeIntervalSince1970 * 1000),
        ]

        sendJson(json)
    }

    /// Send stored user email to the ASG client for Sentry crash reporting
    private func sendStoredUserEmailToAsgClient() {
        let storedEmail = DeviceStore.shared.store.get("bluetooth", "auth_email") as? String ?? ""

        guard !storedEmail.isEmpty else {
            Bridge.log("LIVE: No stored user email to send to ASG client")
            return
        }

        Bridge.log("LIVE: Sending stored user email to ASG client")
        sendUserEmailToGlasses(storedEmail)
    }

    // MARK: - Power Control Methods

    /**
     * Send shutdown command to the glasses.
     * This will initiate a graceful shutdown of the device.
     */
    @objc func sendShutdown() {
        Bridge.log("LIVE: 🔌 Sending shutdown command to glasses")
        let json: [String: Any] = ["type": "shutdown"]
        sendJson(json)
    }

    /**
     * Send reboot command to the glasses.
     * This will initiate a reboot of the device.
     */
    @objc func sendReboot() {
        Bridge.log("LIVE: 🔄 Sending reboot command to glasses")
        let json: [String: Any] = ["type": "reboot"]
        sendJson(json)
    }

    // MARK: - IMU Methods

    /**
     * Request a single IMU reading from the glasses
     * Power-optimized: sensors turn on briefly then off
     */
    @objc func requestImuSingle() {
        Bridge.log("Requesting single IMU reading")
        let json: [String: Any] = ["type": "imu_single"]
        sendJson(json)
    }

    /**
     * Start IMU streaming from the glasses
     * @param rateHz Sampling rate in Hz (1-100)
     * @param batchMs Batching period in milliseconds (0-1000)
     */
    @objc func startImuStream(rateHz: Int, batchMs: Int) {
        Bridge.log("Starting IMU stream: \(rateHz)Hz, batch: \(batchMs)ms")
        let json: [String: Any] = [
            "type": "imu_stream_start",
            "rate_hz": rateHz,
            "batch_ms": batchMs,
        ]
        sendJson(json)
    }

    /**
     * Stop IMU streaming from the glasses
     */
    @objc func stopImuStream() {
        Bridge.log("Stopping IMU stream")
        let json: [String: Any] = ["type": "imu_stream_stop"]
        sendJson(json)
    }

    /**
     * Subscribe to gesture detection on the glasses
     * Power-optimized: uses accelerometer-only at low rate
     * @param gestures Array of gestures to detect ("head_up", "head_down", "nod_yes", "shake_no")
     */
    @objc func subscribeToImuGestures(_ gestures: [String]) {
        Bridge.log("Subscribing to IMU gestures: \(gestures)")
        let json: [String: Any] = [
            "type": "imu_subscribe_gesture",
            "gestures": gestures,
        ]
        sendJson(json)
    }

    /**
     * Unsubscribe from all gesture detection
     */
    @objc func unsubscribeFromImuGestures() {
        Bridge.log("LIVE: Unsubscribing from IMU gestures")
        let json: [String: Any] = ["type": "imu_unsubscribe_gesture"]
        sendJson(json)
    }

    /**
     * Handle IMU response from glasses
     */
    private func handleImuResponse(_ json: [String: Any]) {
        guard let type = json["type"] as? String else {
            Bridge.log("LIVE: IMU response missing type")
            return
        }

        switch type {
        case "imu_response":
            // Single IMU reading
            handleSingleImuData(json)

        case "imu_stream_response":
            // Stream of IMU readings
            handleStreamImuData(json)

        case "imu_gesture_response":
            // Gesture detected
            handleImuGesture(json)

        case "imu_gesture_subscribed":
            // Gesture subscription confirmed
            if let gestures = json["gestures"] as? [String] {
                Bridge.log("LIVE: IMU gesture subscription confirmed: \(gestures)")
            }

        case "imu_ack":
            // Command acknowledgment
            if let message = json["message"] as? String {
                Bridge.log("LIVE: IMU command acknowledged: \(message)")
            }

        case "imu_error":
            // Error response
            if let error = json["error"] as? String {
                Bridge.log("LIVE: IMU error: \(error)")
            }

        default:
            Bridge.log("LIVE: Unknown IMU response type: \(type)")
        }
    }

    private func handleSingleImuData(_ json: [String: Any]) {
        guard let accel = json["accel"] as? [Double],
              let gyro = json["gyro"] as? [Double],
              let mag = json["mag"] as? [Double],
              let quat = json["quat"] as? [Double],
              let euler = json["euler"] as? [Double]
        else {
            Bridge.log("LIVE: Invalid IMU data format")
            return
        }

        Bridge.log(
            String(
                format:
                "LIVE: IMU Single Reading - Accel: [%.2f, %.2f, %.2f], Euler: [%.1f°, %.1f°, %.1f°]",
                accel[0], accel[1], accel[2],
                euler[0], euler[1], euler[2]
            )
        )

        // Emit event for other components
        let eventBody: [String: Any] = [
            "imu_data": [
                "accel": accel,
                "gyro": gyro,
                "mag": mag,
                "quat": quat,
                "euler": euler,
                "timestamp": Date().timeIntervalSince1970 * 1000,
            ],
        ]
        Bridge.sendTypedMessage("imu_data_event", body: eventBody)
    }

    private func handleStreamImuData(_ json: [String: Any]) {
        guard let readings = json["readings"] as? [[String: Any]] else {
            Bridge.log("LIVE: Invalid IMU stream data format")
            return
        }

        for reading in readings {
            handleSingleImuData(reading)
        }
    }

    private func handleImuGesture(_ json: [String: Any]) {
        guard let gesture = json["gesture"] as? String else {
            Bridge.log("LIVE: Invalid IMU gesture format")
            return
        }

        let timestamp = json["timestamp"] as? Double ?? Date().timeIntervalSince1970 * 1000

        Bridge.log("LIVE: IMU Gesture detected: \(gesture)")

        // Emit event for other components
        let eventBody: [String: Any] = [
            "imu_gesture": [
                "gesture": gesture,
                "timestamp": timestamp,
            ],
        ]
        Bridge.sendTypedMessage("imu_gesture_event", body: eventBody)
    }

    // MARK: - Update Methods

    private func updateBatteryStatus(level: Int, isCharging: Bool) {
        DeviceStore.shared.apply("glasses", "batteryLevel", level)
        DeviceStore.shared.apply("glasses", "charging", isCharging)

        if level >= 0 {
            Bridge.sendBatteryStatus(level: level, charging: isCharging)
        }
    }

    private func handleVoiceActivityDetectionStatus(enabled: Bool) {
        Bridge.log("LIVE: Voice Activity Detection \(enabled ? "enabled" : "disabled")")
        Bridge.sendVoiceActivityDetectionStatus(enabled)
    }

    private func handleSpeakingStatus(speaking: Bool) {
        guard voiceActivityDetectionEnabled else {
            Bridge.log("LIVE: Ignoring speaking status because Voice Activity Detection is disabled")
            return
        }
        Bridge.log("LIVE: Speaking status \(speaking ? "speaking" : "not speaking")")
        Bridge.sendSpeakingStatus(speaking)
    }

    private func handleSwitchStatus(switchType: Int, value: Int, timestamp: Int64) {
        Bridge.sendSwitchStatus(switchType: switchType, value: value, timestamp: timestamp)
        if switchType == Self.voiceActivityDetectionSwitchType, value == 0 || value == 1 {
            handleVoiceActivityDetectionStatus(enabled: value == 1)
        }
    }

    private func updateWifiStatus(connected: Bool, ssid: String, ip: String) {
        Bridge.log("LIVE: 🌐 Updating WiFi status - connected: \(connected), ssid: \(ssid)")
        DeviceStore.shared.apply("glasses", "wifiConnected", connected)
        DeviceStore.shared.apply("glasses", "wifiSsid", ssid)
        DeviceStore.shared.apply("glasses", "wifiLocalIp", ip)
        emitWifiStatusChange()
    }

    private func updateHotspotStatus(enabled: Bool, ssid: String, password: String, ip: String) {
        Bridge.log("LIVE: 🔥 Updating hotspot status - enabled: \(enabled), ssid: \(ssid)")
        DeviceStore.shared.apply("glasses", "hotspotEnabled", enabled)
        DeviceStore.shared.apply("glasses", "hotspotSsid", ssid)
        DeviceStore.shared.apply("glasses", "hotspotPassword", password)
        DeviceStore.shared.apply("glasses", "hotspotGatewayIp", ip) // This is the gateway IP from glasses
        emitHotspotStatusChange()
    }

    private func handleHotspotError(errorMessage: String, timestamp: Int64) {
        Bridge.log("LIVE: 🔥 ❌ Hotspot error: \(errorMessage)")
        emitHotspotError(errorMessage: errorMessage, timestamp: timestamp)
    }

    private func emitHotspotError(errorMessage: String, timestamp: Int64) {
        let eventBody: [String: Any] = [
            "errorMessage": errorMessage,
            "timestamp": timestamp,
        ]
        Bridge.sendTypedMessage("hotspot_error", body: eventBody)
    }

    private func handleGalleryStatus(
        photoCount: Int, videoCount: Int, totalCount: Int,
        totalSize: Int64, hasContent: Bool, cameraBusy: Bool,
        cameraBusyReason: String?
    ) {
        Bridge.log(
            "LIVE: 📸 Received gallery status - photos: \(photoCount), videos: \(videoCount), total size: \(totalSize) bytes"
        )

        // Emit gallery status event like other status events
        var eventBody =
            [
                "type": "gallery_status",
                "photos": photoCount,
                "videos": videoCount,
                "total": totalCount,
                "totalSize": totalSize,
                "hasContent": hasContent,
                "cameraBusy": cameraBusy,
            ] as [String: Any]
        if let cameraBusyReason, !cameraBusyReason.isEmpty {
            eventBody["cameraBusyReason"] = cameraBusyReason
        }
        Bridge.sendTypedMessage("gallery_status", body: eventBody)
    }

    private static func galleryCameraBusy(_ json: [String: Any]) -> Bool {
        if let busy = json["cameraBusy"] as? Bool {
            return busy
        }
        if let busy = json["camera_busy"] as? Bool {
            return busy
        }
        if let reason = json["camera_busy"] as? String {
            let normalized = reason.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            return !normalized.isEmpty && normalized != "false"
        }
        return false
    }

    private static func galleryCameraBusyReason(_ json: [String: Any]) -> String? {
        if let reason = json["cameraBusyReason"] as? String, !reason.isEmpty {
            return reason
        }
        if let reason = json["camera_busy"] as? String {
            let normalized = reason.trimmingCharacters(in: .whitespacesAndNewlines)
            return normalized.isEmpty || normalized.lowercased() == "false" ? nil : normalized
        }
        return nil
    }

    // MARK: - Timers

    private func startHeartbeat() {
        Bridge.log("LIVE: 💓 Starting heartbeat mechanism")
        heartbeatCounter = 0

        // Ensure timer is created on main thread (required for RunLoop)
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.heartbeatTimer?.invalidate()
            self.heartbeatTimer = Timer.scheduledTimer(
                withTimeInterval: self.HEARTBEAT_INTERVAL_MS, repeats: true
            ) { [weak self] _ in
                self?.sendHeartbeat()
            }
        }
    }

    private func stopHeartbeat() {
        Bridge.log("LIVE: 💓 Stopping heartbeat mechanism")

        // Ensure timer is stopped on main thread (same thread it was created on)
        DispatchQueue.main.async { [weak self] in
            self?.heartbeatTimer?.invalidate()
            self?.heartbeatTimer = nil
        }

        heartbeatCounter = 0
    }

    private func startSignalStrengthPolling() {
        Bridge.log("LIVE: 📶 Starting RSSI polling")
        stopSignalStrengthPolling()

        requestSignalStrength()

        let interval = DispatchTimeInterval.milliseconds(Int(SIGNAL_STRENGTH_READ_INTERVAL_MS * 1000))
        signalStrengthTimer = DispatchSource.makeTimerSource(queue: bluetoothQueue)
        signalStrengthTimer?.schedule(
            deadline: .now() + interval,
            repeating: interval
        )
        signalStrengthTimer?.setEventHandler { [weak self] in
            self?.requestSignalStrength()
        }
        signalStrengthTimer?.resume()
    }

    private func stopSignalStrengthPolling() {
        signalStrengthTimer?.cancel()
        signalStrengthTimer = nil
        signalStrengthReadInFlight = false
        Bridge.log("LIVE: 📶 Stopping RSSI polling")
    }

    private func requestSignalStrength() {
        guard let peripheral = connectedPeripheral else { return }
        guard !signalStrengthReadInFlight else {
            Bridge.log("LIVE: 📶 Skipping RSSI read - previous read still pending")
            return
        }

        signalStrengthReadInFlight = true
        peripheral.readRSSI()
    }

    private func updateSignalStrength(_ rssi: Int) {
        let now = Int(Date().timeIntervalSince1970 * 1000)
        DeviceStore.shared.apply("glasses", "signalStrength", rssi)
        DeviceStore.shared.apply("glasses", "signalStrengthUpdatedAt", now)
        Bridge.log("LIVE: 📶 RSSI: \(rssi) dBm")
    }

    private func sendHeartbeat() {
        guard fullyBooted, connectionState == ConnTypes.CONNECTED else {
            Bridge.log("LIVE: Skipping heartbeat - glasses not fully booted or not connected")
            return
        }

        // Send ping message to glasses hardware (no ACK needed for heartbeats)
        let pingJson: [String: Any] = ["type": "ping"]
        sendJson(pingJson, requireAck: false)

        // Send heartbeat to AsgClientService for connection monitoring
        let serviceHeartbeat: [String: Any] = [
            "type": "service_heartbeat",
            "timestamp": Int64(Date().timeIntervalSince1970 * 1000), // milliseconds
            "heartbeat_counter": heartbeatCounter,
        ]
        sendJson(serviceHeartbeat, requireAck: false)

        heartbeatCounter += 1
        Bridge.log("LIVE: 💓 Heartbeat #\(heartbeatCounter) sent (BLE ping + service heartbeat)")

        // Request battery status periodically
        if heartbeatCounter % BATTERY_REQUEST_EVERY_N_HEARTBEATS == 0 {
            Bridge.log("LIVE: 🔋 Requesting battery status (heartbeat #\(heartbeatCounter))")
            requestBatteryStatus()
        }
    }

    private var readinessCheckDispatchTimer: DispatchSourceTimer?

    private func startReadinessCheckLoop() {
        Bridge.log("LIVE: startReadinessCheckLoop()")
        stopReadinessCheckLoop()

        readinessCheckCounter = 0
        fullyBooted = false
        connected = false

        Bridge.log("LIVE: 🔄 Starting glasses SOC readiness check loop")

        readinessCheckDispatchTimer = DispatchSource.makeTimerSource(queue: bluetoothQueue)
        readinessCheckDispatchTimer!.schedule(
            deadline: .now(), repeating: READINESS_CHECK_INTERVAL_MS
        )

        readinessCheckDispatchTimer!.setEventHandler { [weak self] in
            guard let self else { return }

            self.readinessCheckCounter += 1
            Bridge.log(
                "LIVE: 🔄 Readiness check #\(self.readinessCheckCounter): waiting for glasses SOC to boot"
            )
            // requestReadyK900()

            let readyMsg: [String: Any] = [
                "type": "phone_ready",
                "timestamp": Int64(Date().timeIntervalSince1970 * 1000),
            ]
            // Send it through our data channel
            sendJson(readyMsg, wakeUp: true)
        }

        readinessCheckDispatchTimer!.resume()
    }

    private func requestReadyK900() {
        // cs_hrt is a K900 protocol command handled directly by BES2700
        // It doesn't go through MTK Android, so it doesn't use ACK system
        let command: [String: Any] = [
            "C": "cs_hrt", // Heartbeat command for BES2700
            "B": "", // Empty body
        ]

        if sendRawK900Command(command) {
            Bridge.log("LIVE: Sent cs_hrt via queue (BES-handled command)")
        } else {
            Bridge.log("LIVE: Failed to send readiness check")
        }
    }

    private func stopReadinessCheckLoop() {
        readinessCheckDispatchTimer?.cancel()
        readinessCheckDispatchTimer = nil
        Bridge.log("LIVE: 🔄 Stopped glasses SOC readiness check loop")
    }

    private func startConnectionTimeout() {
        connectionTimeoutTimer?.invalidate()
        connectionTimeoutTimer = Timer.scheduledTimer(
            withTimeInterval: Double(CONNECTION_TIMEOUT_MS) / 1_000_000_000, repeats: false
        ) { [weak self] _ in
            guard let self else { return }

            if self.isConnecting, self.connectionState != ConnTypes.CONNECTED {
                Bridge.log("LIVE: Connection timeout - closing GATT connection")
                self.isConnecting = false

                if let peripheral = self.connectedPeripheral {
                    self.centralManager?.cancelPeripheralConnection(peripheral)
                }

                self.handleReconnection()
            }
        }
    }

    private func stopConnectionTimeout() {
        connectionTimeoutTimer?.invalidate()
        connectionTimeoutTimer = nil
    }

    private func stopAllTimers() {
        stopHeartbeat()
        stopSignalStrengthPolling()
        stopReadinessCheckLoop()
        stopConnectionTimeout()
        stopMicBeat() // Stop LC3 audio micbeat
        pendingMessageTimer?.invalidate()
        pendingMessageTimer = nil
        reconnectionWorkItem?.cancel()
        reconnectionWorkItem = nil
    }

    // MARK: - Event Emission

    private func emitDiscoveredDevice(_ name: String, identifier: String = "", rssi: Int? = nil) {
        Bridge.sendDiscoveredDevice("Mentra Live", name, deviceAddress: identifier, rssi: rssi)
    }

    private func emitStopScanEvent() {
        // Use the standardized typed message function
        let body = [
            "deviceModel": "Mentra Live",
        ]
        Bridge.sendTypedMessage("compatible_glasses_search_stop", body: body)
    }

    // private func emitBatteryLevelEvent(level: Int, charging: Bool) {
    //   let eventBody: [String: Any] = [
    //     "battery_level": level,
    //     "is_charging": charging
    //   ]
    //   emitEvent("BatteryLevelEvent", body: eventBody)
    // }

    private func emitWifiStatusChange() {
        Bridge.sendWifiStatusChange(connected: wifiConnected, ssid: wifiSsid, localIp: wifiLocalIp)
    }

    private func emitHotspotStatusChange() {
        guard let status = HotspotStatus.fromStoreFields(
            enabled: hotspotEnabled,
            ssid: hotspotSsid,
            password: hotspotPassword,
            localIp: hotspotGatewayIp
        ) else {
            return
        }
        Bridge.sendTypedMessage("hotspot_status_change", body: status.values)
    }

    private func emitRtmpStreamStatus(_ json: [String: Any]) {
        Bridge.sendTypedMessage("stream_status", body: json)
    }

    private func emitPhotoStatus(_ json: [String: Any]) {
        Bridge.sendPhotoStatus(json)
    }

    private func emitPhotoResponse(_ json: [String: Any]) {
        Bridge.sendPhotoResponse(json)
    }

    private func emitButtonPress(buttonId: String, pressType: String, timestamp: Int64) {
        let eventBody: [String: Any] = [
            "device_model": "Mentra Live",
            "button_id": buttonId,
            "press_type": pressType,
            "timestamp": timestamp,
        ]

        // emitEvent("onCoreEvent", body: eventBody)
    }

    private func emitVersionInfo(
        appVersion: String, buildNumber: String, deviceModel: String, androidVersion: String,
        otaVersionUrl: String, firmwareVersion: String, bluetoothMacAddress: String
    ) {
        let eventBody: [String: Any] = [
            "app_version": appVersion,
            "build_number": buildNumber,
            "device_model": deviceModel,
            "android_version": androidVersion,
            "ota_version_url": otaVersionUrl,
            "firmware_version": firmwareVersion,
            "bt_mac_address": bluetoothMacAddress,
        ]

        Bridge.sendVersionInfo(eventBody)
    }

    private func emitKeepAliveAck(_ json: [String: Any]) {
        Bridge.sendTypedMessage("keep_alive_ack", body: json)
    }

    // MARK: - Cleanup

    private func destroy() {
        Bridge.log("Destroying MentraLiveManager")

        isKilled = true

        // Stop scanning
        if isScanning {
            stopScan()
            emitStopScanEvent()
        }

        // Stop phone audio monitor
        phoneAudioMonitor?.stopMonitoring()
        Bridge.log("LIVE: 🎵 Phone audio monitor stopped")

        // Stop all timers
        stopAllTimers()
        incomingChunkReassembler.clear()

        // Disconnect BLE
        if let peripheral = connectedPeripheral {
            centralManager?.cancelPeripheralConnection(peripheral)
        }

        DeviceStore.shared.apply("glasses", "connected", false)
        DeviceStore.shared.apply("glasses", "fullyBooted", false)
        DeviceStore.shared.apply("glasses", "wifiConnected", false)
        DeviceStore.shared.apply("glasses", "wifiSsid", "")
        DeviceStore.shared.apply("glasses", "wifiLocalIp", "")
        DeviceStore.shared.apply("glasses", "hotspotEnabled", false)
        DeviceStore.shared.apply("glasses", "hotspotSsid", "")
        DeviceStore.shared.apply("glasses", "hotspotPassword", "")
        DeviceStore.shared.apply("glasses", "hotspotGatewayIp", "")

        connectedPeripheral = nil
        centralManager?.delegate = nil
        centralManager = nil

        updateConnectionState(ConnTypes.DISCONNECTED)
    }
}

// MARK: - K900 Protocol Utilities

extension MentraLive {
    /**
     * Pack raw byte data with K900 BES2700 protocol format
     * Format: ## + command_type + length(2bytes) + data + $$
     */
    private func packDataCommand(_ data: Data?, cmdType: UInt8) -> Data? {
        guard let data else { return nil }

        let dataLength = data.count

        // Command structure: ## + type + length(2 bytes) + data + $$
        var result = Data(capacity: dataLength + 7) // 2(start) + 1(type) + 2(length) + data + 2(end)

        // Start code ##
        result.append(contentsOf: K900ProtocolUtils.CMD_START_CODE)

        // Command type
        result.append(cmdType)

        // Length (2 bytes, big-endian)
        result.append(UInt8((dataLength >> 8) & 0xFF)) // MSB first
        result.append(UInt8(dataLength & 0xFF)) // LSB second

        // Copy the data
        result.append(data)

        // End code $$
        result.append(contentsOf: K900ProtocolUtils.CMD_END_CODE)

        return result
    }

    /**
     * Pack raw byte data with K900 BES2700 protocol format for phone-to-device communication
     * Format: ## + command_type + length(2bytes) + data + $$
     * Uses little-endian byte order for length field
     */
    private func packDataToK900(_ data: Data?, cmdType: UInt8) -> Data? {
        guard let data else { return nil }

        let dataLength = data.count

        // Command structure: ## + type + length(2 bytes) + data + $$
        var result = Data(capacity: dataLength + 7) // 2(start) + 1(type) + 2(length) + data + 2(end)

        // Start code ##
        result.append(contentsOf: K900ProtocolUtils.CMD_START_CODE)

        // Command type
        result.append(cmdType)

        // Length (2 bytes, little-endian for phone-to-device)
        result.append(UInt8(dataLength & 0xFF)) // LSB first
        result.append(UInt8((dataLength >> 8) & 0xFF)) // MSB second

        // Copy the data
        result.append(data)

        // End code $$
        result.append(contentsOf: K900ProtocolUtils.CMD_END_CODE)

        return result
    }

    /**
     * Pack a JSON string for phone-to-K900 device communication
     * 1. Wrap with C-field: {"C": jsonData}
     * 2. Then pack with BES2700 protocol using little-endian: ## + type + length + {"C": jsonData} + $$
     */
    private func packJson(_ jsonData: String?, wakeUp: Bool = false) -> Data? {
        guard let jsonData else { return nil }

        do {
            // First wrap with C-field
            var wrapper: [String: Any] = [K900ProtocolUtils.FIELD_C: jsonData]
            if wakeUp {
                wrapper["W"] = 1 // Add W field as seen in MentraLiveSGC (optional)
            }

            // Convert to string
            let jsonData = try JSONSerialization.data(withJSONObject: wrapper)
            guard let wrappedJson = String(data: jsonData, encoding: .utf8) else { return nil }

            // Then pack with BES2700 protocol format using little-endian
            let jsonBytes = wrappedJson.data(using: .utf8)!
            return packDataToK900(jsonBytes, cmdType: K900ProtocolUtils.CMD_TYPE_STRING)

        } catch {
            Bridge.log("Error creating JSON wrapper for K900: \(error)")
            return nil
        }
    }

    /**
     * Create a C-wrapped JSON object ready for protocol formatting
     * Format: {"C": content}
     */
    private func createCWrappedJson(_ content: String) -> String? {
        do {
            let wrapper: [String: Any] = [K900ProtocolUtils.FIELD_C: content]
            let jsonData = try JSONSerialization.data(withJSONObject: wrapper)
            return String(data: jsonData, encoding: .utf8)
        } catch {
            Bridge.log("Error creating C-wrapped JSON: \(error)")
            return nil
        }
    }

    /**
     * Check if data follows the K900 BES2700 protocol format
     * Verifies if data starts with ## markers
     */
    private func isK900ProtocolFormat(_ data: Data?) -> Bool {
        guard let data, data.count >= 7 else { return false }

        let bytes = [UInt8](data)
        return bytes[0] == K900ProtocolUtils.CMD_START_CODE[0]
            && bytes[1] == K900ProtocolUtils.CMD_START_CODE[1]
    }

    // MARK: - Glasses media volume (K900)

    private func k900JsonInt(_ json: [String: Any], _ key: String) -> Int? {
        if let v = json[key] as? Int { return v }
        if let n = json[key] as? NSNumber { return n.intValue }
        return nil
    }

    /// Parse K900 `B` field as dictionary or JSON string.
    private func k900ParseBody(_ body: Any?) -> [String: Any]? {
        if let d = body as? [String: Any] { return d }
        if let s = body as? String,
           let data = s.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        {
            return obj
        }
        return nil
    }

    private func cancelGlassesMediaVolumeTimeout() {
        glassesMediaVolumeTimeoutWorkItem?.cancel()
        glassesMediaVolumeTimeoutWorkItem = nil
    }

    private func scheduleGlassesMediaVolumeTimeout() {
        cancelGlassesMediaVolumeTimeout()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.glassesMediaVolumeLock.lock()
            let getC = self.glassesMediaVolumeGetCompletion
            let setC = self.glassesMediaVolumeSetCompletion
            self.glassesMediaVolumeGetCompletion = nil
            self.glassesMediaVolumeSetCompletion = nil
            self.glassesMediaVolumeLock.unlock()
            let err = NSError(
                domain: "MentraLive",
                code: -1001,
                userInfo: [NSLocalizedDescriptionKey: "glasses_volume_timeout"]
            )
            if let getC {
                DispatchQueue.main.async { getC(.failure(err)) }
            }
            if let setC {
                DispatchQueue.main.async { setC(.failure(err)) }
            }
        }
        glassesMediaVolumeTimeoutWorkItem = work
        bluetoothQueue.asyncAfter(deadline: .now() + Self.glassesMediaVolumeTimeoutSec, execute: work)
    }

    private func failPendingGlassesVolumeGet(_ error: Error) {
        cancelGlassesMediaVolumeTimeout()
        glassesMediaVolumeLock.lock()
        let c = glassesMediaVolumeGetCompletion
        glassesMediaVolumeGetCompletion = nil
        glassesMediaVolumeLock.unlock()
        if let c {
            DispatchQueue.main.async { c(.failure(error)) }
        }
    }

    private func failPendingGlassesVolumeSet(_ error: Error) {
        cancelGlassesMediaVolumeTimeout()
        glassesMediaVolumeLock.lock()
        let c = glassesMediaVolumeSetCompletion
        glassesMediaVolumeSetCompletion = nil
        glassesMediaVolumeLock.unlock()
        if let c {
            DispatchQueue.main.async { c(.failure(error)) }
        }
    }

    private func handleSrGetvol(_ json: [String: Any]) {
        let body = k900ParseBody(json["B"])
        var status = k900JsonInt(json, "S") ?? -1
        if status < 0, let b = body, let s = k900JsonInt(b, "S") {
            status = s
        }
        let vol = body.flatMap { k900JsonInt($0, "vol") } ?? -1

        glassesMediaVolumeLock.lock()
        let waiting = glassesMediaVolumeGetCompletion != nil
        glassesMediaVolumeLock.unlock()

        guard waiting else {
            Bridge.log("LIVE: sr_getvol received with no pending request (status=\(status), vol=\(vol))")
            return
        }

        guard vol >= 0, vol <= 15 else {
            Bridge.log("LIVE: sr_getvol invalid vol=\(vol)")
            failPendingGlassesVolumeGet(
                NSError(
                    domain: "MentraLive",
                    code: -1002,
                    userInfo: [NSLocalizedDescriptionKey: "glasses_volume_invalid_response"]
                )
            )
            return
        }

        Bridge.log("LIVE: sr_getvol received vol=\(vol) (0-15), statusCode=\(status)")

        cancelGlassesMediaVolumeTimeout()
        glassesMediaVolumeLock.lock()
        let c = glassesMediaVolumeGetCompletion
        glassesMediaVolumeGetCompletion = nil
        glassesMediaVolumeLock.unlock()
        if let c {
            DispatchQueue.main.async {
                c(.success(["level": vol, "statusCode": status]))
            }
        }
    }

    private func handleSrVol(_ json: [String: Any]) {
        let status = k900JsonInt(json, "S") ?? -1

        glassesMediaVolumeLock.lock()
        let waiting = glassesMediaVolumeSetCompletion != nil
        glassesMediaVolumeLock.unlock()

        guard waiting else {
            Bridge.log("LIVE: sr_vol received with no pending request (status=\(status))")
            return
        }

        cancelGlassesMediaVolumeTimeout()
        glassesMediaVolumeLock.lock()
        let c = glassesMediaVolumeSetCompletion
        glassesMediaVolumeSetCompletion = nil
        glassesMediaVolumeLock.unlock()
        if let c {
            DispatchQueue.main.async {
                c(.success(["statusCode": status]))
            }
        }
    }

    private func sendGlassesMediaVolumeGetCommand() -> Bool {
        let command: [String: Any] = [
            "C": "cs_getvol",
            "V": 1,
            "B": "",
        ]
        return sendRawK900Command(command, wakeUp: true)
    }

    private func sendGlassesMediaVolumeSetCommand(level: Int) -> Bool {
        let clamped = max(0, min(15, level))
        do {
            let bodyData = try JSONSerialization.data(withJSONObject: ["vol": clamped])
            guard let bodyString = String(data: bodyData, encoding: .utf8) else { return false }
            let command: [String: Any] = [
                "C": "cs_vol",
                "V": 1,
                "B": bodyString,
            ]
            return sendRawK900Command(command, wakeUp: true)
        } catch {
            Bridge.log("LIVE: Error encoding cs_vol body: \(error)")
            return false
        }
    }

    /// Read glasses media step volume (0–15) via K900 `cs_getvol` / `sr_getvol`.
    func getGlassesMediaVolume(completion: @escaping (Result<[String: Any], Error>) -> Void) {
        glassesMediaVolumeLock.lock()
        if glassesMediaVolumeGetCompletion != nil || glassesMediaVolumeSetCompletion != nil {
            glassesMediaVolumeLock.unlock()
            completion(
                .failure(
                    NSError(
                        domain: "MentraLive",
                        code: -1003,
                        userInfo: [NSLocalizedDescriptionKey: "glasses_volume_busy"]
                    )
                )
            )
            return
        }
        glassesMediaVolumeGetCompletion = completion
        glassesMediaVolumeLock.unlock()

        guard connectionState == ConnTypes.CONNECTED, fullyBooted else {
            failPendingGlassesVolumeGet(
                NSError(
                    domain: "MentraLive",
                    code: -1004,
                    userInfo: [NSLocalizedDescriptionKey: "glasses_not_ready"]
                )
            )
            return
        }

        scheduleGlassesMediaVolumeTimeout()
        if !sendGlassesMediaVolumeGetCommand() {
            failPendingGlassesVolumeGet(
                NSError(
                    domain: "MentraLive",
                    code: -1005,
                    userInfo: [NSLocalizedDescriptionKey: "glasses_volume_send_failed"]
                )
            )
        }
    }

    /// Set glasses media step volume (0–15) via K900 `cs_vol` / `sr_vol`.
    func setGlassesMediaVolume(level: Int, completion: @escaping (Result<[String: Any], Error>) -> Void) {
        glassesMediaVolumeLock.lock()
        if glassesMediaVolumeGetCompletion != nil || glassesMediaVolumeSetCompletion != nil {
            glassesMediaVolumeLock.unlock()
            completion(
                .failure(
                    NSError(
                        domain: "MentraLive",
                        code: -1003,
                        userInfo: [NSLocalizedDescriptionKey: "glasses_volume_busy"]
                    )
                )
            )
            return
        }
        glassesMediaVolumeSetCompletion = completion
        glassesMediaVolumeLock.unlock()

        guard connectionState == ConnTypes.CONNECTED, fullyBooted else {
            failPendingGlassesVolumeSet(
                NSError(
                    domain: "MentraLive",
                    code: -1004,
                    userInfo: [NSLocalizedDescriptionKey: "glasses_not_ready"]
                )
            )
            return
        }

        scheduleGlassesMediaVolumeTimeout()
        if !sendGlassesMediaVolumeSetCommand(level: level) {
            failPendingGlassesVolumeSet(
                NSError(
                    domain: "MentraLive",
                    code: -1005,
                    userInfo: [NSLocalizedDescriptionKey: "glasses_volume_send_failed"]
                )
            )
        }
    }

    private func sendRawK900Command(_ command: [String: Any], wakeUp: Bool = false) -> Bool {
        do {
            var payload = command
            if wakeUp {
                payload["W"] = 1
            }
            let commandData = try JSONSerialization.data(withJSONObject: payload)
            guard
                let packet = packDataToK900(commandData, cmdType: K900ProtocolUtils.CMD_TYPE_STRING)
            else {
                Bridge.log("LIVE: Failed to pack raw K900 command")
                return false
            }
            queueSend(packet, id: "-1")
            return true
        } catch {
            Bridge.log("LIVE: Error building raw K900 command: \(error)")
            return false
        }
    }

    private func sendRgbLedControlAuthority(_ claimControl: Bool) {
        do {
            let bodyData = try JSONSerialization.data(withJSONObject: ["on": claimControl])
            guard let bodyString = String(data: bodyData, encoding: .utf8) else {
                Bridge.log("LIVE: Failed to encode RGB LED authority body")
                return
            }

            let command: [String: Any] = [
                "C": "android_control_led",
                "V": 1,
                "B": bodyString,
            ]

            if sendRawK900Command(command, wakeUp: true) {
                rgbLedAuthorityClaimed = claimControl
                Bridge.log("LIVE: RGB LED authority \(claimControl ? "claimed" : "released")")
            } else {
                Bridge.log("LIVE: Failed to send RGB LED authority command")
                if !claimControl {
                    rgbLedAuthorityClaimed = false
                }
            }
        } catch {
            Bridge.log("LIVE: Error encoding RGB LED authority payload: \(error)")
        }
    }

    private func setTouchEventReporting(_ enable: Bool) {
        do {
            let bodyData = try JSONSerialization.data(withJSONObject: [
                "type": 26, "switch": enable,
            ])
            guard let bodyString = String(data: bodyData, encoding: .utf8) else {
                Bridge.log("LIVE: Failed to encode touch event control payload")
                return
            }

            let command: [String: Any] = [
                "C": "cs_swit",
                "V": 1,
                "B": bodyString,
            ]

            if sendRawK900Command(command, wakeUp: true) {
                Bridge.log("LIVE: Touch event reporting \(enable ? "enabled" : "disabled")")
            } else {
                Bridge.log("LIVE: Failed to send touch event reporting command")
            }
        } catch {
            Bridge.log("LIVE: Error encoding touch event control payload: \(error)")
        }
    }

    private func setSwipeVolumeControl(_ enable: Bool) {
        do {
            let bodyData = try JSONSerialization.data(withJSONObject: ["switch": enable])
            guard let bodyString = String(data: bodyData, encoding: .utf8) else {
                Bridge.log("LIVE: Failed to encode swipe volume payload")
                return
            }

            let command: [String: Any] = [
                "C": "cs_fbvol",
                "V": 1,
                "B": bodyString,
            ]

            if sendRawK900Command(command, wakeUp: true) {
                Bridge.log("LIVE: Swipe volume control \(enable ? "enabled" : "disabled")")
            } else {
                Bridge.log("LIVE: Failed to send swipe volume command")
            }
        } catch {
            Bridge.log("LIVE: Error encoding swipe volume payload: \(error)")
        }
    }

    func sendRgbLedControl(
        requestId: String,
        packageName: String?,
        action: String,
        color: String?,
        onDurationMs: Int,
        offDurationMs: Int,
        count: Int
    ) {
        guard connectionState == ConnTypes.CONNECTED, fullyBooted else {
            Bridge.log("LIVE: Cannot handle RGB LED control - glasses not connected")
            Bridge.sendRgbLedControlResponse(
                requestId: requestId, success: false, error: "glasses_not_connected"
            )
            return
        }

        if !rgbLedAuthorityClaimed {
            sendRgbLedControlAuthority(true)
        }

        var command: [String: Any] = [
            "requestId": requestId,
        ]

        if let packageName, !packageName.isEmpty {
            command["packageName"] = packageName
        }

        switch action {
        case "on":
            let ledIndex = ledIndex(for: color)
            command["type"] = "rgb_led_control_on"
            command["led"] = ledIndex
            command["ontime"] = onDurationMs
            command["offtime"] = offDurationMs
            command["count"] = count
        case "off":
            command["type"] = "rgb_led_control_off"
        default:
            Bridge.log("LIVE: Unsupported RGB LED action: \(action)")
            Bridge.sendRgbLedControlResponse(
                requestId: requestId, success: false, error: "unsupported_action"
            )
            return
        }

        Bridge.log("LIVE: Forwarding RGB LED command to glasses: \(command)")
        sendJson(command, wakeUp: true)
    }

    private func ledIndex(for color: String?) -> Int {
        guard let color else { return 0 }
        switch color.lowercased() {
        case "red": return 0
        case "green": return 1
        case "blue": return 2
        case "orange": return 3
        case "white": return 4
        default:
            return 0
        }
    }

    private func parseTimestamp(_ value: Any?) -> Int64 {
        if let int64 = value as? Int64 {
            return int64
        }
        if let intValue = value as? Int {
            return Int64(intValue)
        }
        if let doubleValue = value as? Double {
            return Int64(doubleValue)
        }
        return Int64(Date().timeIntervalSince1970 * 1000)
    }

    private func emitSettingsAck(_ json: [String: Any]) {
        var body = json
        if let requestId = body["request_id"], body["requestId"] == nil {
            body["requestId"] = requestId
        }
        if let roiPosition = body["roi_position"], body["roiPosition"] == nil {
            body["roiPosition"] = roiPosition
        }
        if let errorCode = body["error_code"], body["errorCode"] == nil {
            body["errorCode"] = errorCode
        }
        if let errorMessage = body["error_message"], body["errorMessage"] == nil {
            body["errorMessage"] = errorMessage
        }
        if let hardwareApplied = body["hardware_applied"], body["hardwareApplied"] == nil {
            body["hardwareApplied"] = hardwareApplied
        }
        body.removeValue(forKey: "request_id")
        body.removeValue(forKey: "roi_position")
        body.removeValue(forKey: "error_code")
        body.removeValue(forKey: "error_message")
        body.removeValue(forKey: "hardware_applied")
        if body["timestamp"] == nil {
            body["timestamp"] = Int64(Date().timeIntervalSince1970 * 1000)
        }
        Bridge.sendSettingsAck(body)
    }

    private func emitVideoRecordingStatus(_ json: [String: Any]) {
        var body = json
        if let requestId = body["request_id"], body["requestId"] == nil {
            body["requestId"] = requestId
        }
        if let details = body["error_details"], body["details"] == nil {
            body["details"] = details
        }
        body.removeValue(forKey: "request_id")
        body.removeValue(forKey: "error_details")
        if body["timestamp"] == nil {
            body["timestamp"] = Int64(Date().timeIntervalSince1970 * 1000)
        }
        Bridge.sendVideoRecordingStatus(body)
    }

    /**
     * Check if a JSON string is already properly formatted for K900 protocol
     */
    private func isCWrappedJson(_ jsonStr: String) -> Bool {
        do {
            guard let data = jsonStr.data(using: .utf8) else { return false }
            let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]

            // Check for simple C-wrapping {"C": "content"} - only one field
            if let json, json.keys.contains(K900ProtocolUtils.FIELD_C), json.count == 1 {
                return true
            }

            // Check for full K900 format {"C": "command", "V": val, "B": body}
            if let json,
               json.keys.contains(K900ProtocolUtils.FIELD_C),
               json.keys.contains(K900ProtocolUtils.FIELD_V),
               json.keys.contains(K900ProtocolUtils.FIELD_B)
            {
                return true
            }

            return false
        } catch {
            return false
        }
    }

    /**
     * Extract payload from K900 protocol formatted data received from device
     * Uses little-endian byte order for length field
     */
    private func extractPayloadFromK900(_ protocolData: Data?) -> Data? {
        guard let protocolData,
              isK900ProtocolFormat(protocolData),
              protocolData.count >= 7
        else {
            return nil
        }

        let bytes = [UInt8](protocolData)

        // Extract length (little-endian for device-to-phone)
        let length = Int(bytes[3]) | (Int(bytes[4]) << 8)

        if length + 7 > protocolData.count {
            return nil // Invalid length
        }

        // Extract payload
        return protocolData.subdata(in: 5 ..< (5 + length))
    }

    private func sendUserSettings() {
        Bridge.log("Sending user settings to glasses")

        // Send button video recording settings
        sendButtonVideoRecordingSettings()

        // Send button max recording time
        let maxTime = DeviceStore.shared.get("bluetooth", "button_max_recording_time") as! Int
        sendButtonMaxRecordingTime(maxTime)

        // Send button photo settings
        sendButtonPhotoSettings()

        // Send button camera LED setting
        sendButtonCameraLedSetting()

        // Send camera FOV setting (K900 / Mentra Live)
        sendCameraFovSetting()

        // Send gallery mode state (camera app running status)
        sendGalleryMode()

        // Send glasses-side Voice Activity Detection setting.
        sendVoiceActivityDetectionSetting()
    }

    func sendVoiceActivityDetectionSetting() {
        let enabled = DeviceStore.shared.get("bluetooth", "voice_activity_detection_enabled") as? Bool
            ?? BluetoothSdkDefaults.voiceActivityDetectionEnabled
        Bridge.log("LIVE: 🎤 Sending Voice Activity Detection setting to glasses: \(enabled)")

        guard connectedPeripheral != nil, txCharacteristic != nil else {
            Bridge.log("Cannot send Voice Activity Detection setting - BLE write path not ready")
            return
        }

        do {
            let bodyData = try JSONSerialization.data(withJSONObject: [
                "type": Self.voiceActivityDetectionSwitchType,
                "switch": enabled ? 1 : 0,
            ])
            guard let bodyString = String(data: bodyData, encoding: .utf8) else {
                Bridge.log("LIVE: Failed to encode Voice Activity Detection payload")
                return
            }
            let command: [String: Any] = [
                "C": "cs_swit",
                "V": 1,
                "B": bodyString,
            ]
            if sendRawK900Command(command, wakeUp: true) {
                Bridge.sendVoiceActivityDetectionStatus(enabled)
            } else {
                Bridge.log("LIVE: Failed to send Voice Activity Detection setting command")
            }
        } catch {
            Bridge.log("LIVE: Error encoding Voice Activity Detection payload: \(error)")
        }
    }

    func sendButtonVideoRecordingSettings() {
        let settings =
            DeviceStore.shared.get("bluetooth", "button_video_settings") as? [String: Any] ?? [
                "width": 1280,
                "height": 720,
                "fps": 30,
            ]
        let width = settings["width"] as? Int ?? 1280
        let height = settings["height"] as? Int ?? 720
        let fps = settings["fps"] as? Int ?? 30

        // Use defaults if not set
        let finalWidth = width > 0 ? width : 1280
        let finalHeight = height > 0 ? height : 720
        let finalFps = fps > 0 ? fps : 30

        sendButtonVideoRecordingSettings(requestId: nil, width: finalWidth, height: finalHeight, fps: finalFps)
    }

    func sendButtonVideoRecordingSettings(requestId: String?, width: Int, height: Int, fps: Int) {
        Bridge.log("Sending button video recording settings: \(width)x\(height)@\(fps)fps")

        guard connectionState == ConnTypes.CONNECTED else {
            Bridge.log("Cannot send button video recording settings - not connected")
            return
        }

        var json: [String: Any] = [
            "type": "button_video_recording_setting",
            "params": [
                "width": width,
                "height": height,
                "fps": fps,
            ],
        ]
        if let requestId, !requestId.isEmpty {
            json["request_id"] = requestId
        }
        sendJson(json, wakeUp: true)
    }

    func sendButtonMaxRecordingTime() {
        let maxTime = DeviceStore.shared.get("bluetooth", "button_max_recording_time") as? Int ?? 10
        sendButtonMaxRecordingTime(requestId: nil, minutes: maxTime)
    }

    func sendButtonMaxRecordingTime(requestId: String?, minutes maxTime: Int) {
        Bridge.log("Sending button max recording time: \(maxTime) minutes")

        guard connectionState == ConnTypes.CONNECTED else {
            Bridge.log("Cannot send button max recording time - not connected")
            return
        }

        var json: [String: Any] = [
            "type": "button_max_recording_time",
            "minutes": maxTime,
        ]
        if let requestId, !requestId.isEmpty {
            json["request_id"] = requestId
        }
        sendJson(json, wakeUp: true)
    }

    func sendButtonPhotoSettings() {
        let size = DeviceStore.shared.get("bluetooth", "button_photo_size") as? String
        let mfnr = DeviceStore.shared.get("bluetooth", "button_photo_mfnr") as? Bool
        let zsl = DeviceStore.shared.get("bluetooth", "button_photo_zsl") as? Bool
        let noiseReduction = DeviceStore.shared.get("bluetooth", "button_photo_noise_reduction") as? Bool
        let edgeEnhancement = DeviceStore.shared.get("bluetooth", "button_photo_edge_enhancement") as? Bool
        let ispDigitalGain = DeviceStore.shared.get("bluetooth", "button_photo_isp_digital_gain") as? Int
        let ispAnalogGain = DeviceStore.shared.get("bluetooth", "button_photo_isp_analog_gain") as? String
        let aeExposureDivisor = DeviceStore.shared.get("bluetooth", "button_photo_ae_exposure_divisor") as? Int
        let isoCap = DeviceStore.shared.get("bluetooth", "button_photo_iso_cap") as? Int
        let compressStr = DeviceStore.shared.get("bluetooth", "button_photo_compress") as? String
        let sound = DeviceStore.shared.get("bluetooth", "button_photo_sound") as? Bool

        let settings = ButtonPhotoSettings(
            size: ButtonPhotoSize(normalizedRawValue: size ?? "medium"),
            mfnr: mfnr,
            zsl: zsl,
            noiseReduction: noiseReduction,
            edgeEnhancement: edgeEnhancement,
            ispDigitalGain: ispDigitalGain,
            ispAnalogGain: ispAnalogGain,
            aeExposureDivisor: aeExposureDivisor,
            isoCap: isoCap,
            compress: compressStr,
            sound: sound,
            resetCaptureTuning: false
        )

        sendButtonPhotoSettings(requestId: nil, settings: settings)
    }

    func sendButtonPhotoSettings(requestId: String?, size: String) {
        sendButtonPhotoSettings(requestId: requestId, settings: ButtonPhotoSettings(size: ButtonPhotoSize(normalizedRawValue: size)))
    }

    func sendButtonPhotoSettings(requestId: String?, settings: ButtonPhotoSettings) {
        var details = settings.size.map { "size=\($0.rawValue)" } ?? "size=unchanged"
        if let mfnr = settings.mfnr {
            details += ", mfnr=\(mfnr)"
        }
        if let zsl = settings.zsl {
            details += ", zsl=\(zsl)"
        }
        if let noiseReduction = settings.noiseReduction {
            details += ", noiseReduction=\(noiseReduction)"
        }
        if let edgeEnhancement = settings.edgeEnhancement {
            details += ", edgeEnhancement=\(edgeEnhancement)"
        }
        if let ispDigitalGain = settings.ispDigitalGain {
            details += ", ispDigitalGain=\(ispDigitalGain)"
        }
        if let ispAnalogGain = settings.ispAnalogGain {
            details += ", ispAnalogGain=\(ispAnalogGain)"
        }
        if let aeExposureDivisor = settings.aeExposureDivisor {
            details += ", aeExposureDivisor=\(aeExposureDivisor)"
        }
        if let isoCap = settings.isoCap {
            details += ", isoCap=\(isoCap)"
        }
        if let compress = settings.compress {
            details += ", compress=\(compress)"
        }
        if let sound = settings.sound {
            details += ", sound=\(sound)"
        }
        Bridge.log("Sending button photo setting: \(details)")

        guard connectionState == ConnTypes.CONNECTED else {
            Bridge.log("Cannot send button photo settings - not connected")
            return
        }

        var json: [String: Any] = [
            "type": "button_photo_setting",
        ]
        if let size = settings.size {
            json["size"] = size.rawValue
        }
        if let requestId, !requestId.isEmpty {
            json["request_id"] = requestId
        }
        if let mfnr = settings.mfnr {
            json["mfnr"] = mfnr
        }
        if let zsl = settings.zsl {
            json["zsl"] = zsl
        }
        if let noiseReduction = settings.noiseReduction {
            json["noiseReduction"] = noiseReduction
        }
        if let edgeEnhancement = settings.edgeEnhancement {
            json["edgeEnhancement"] = edgeEnhancement
        }
        if let ispDigitalGain = settings.ispDigitalGain {
            json["ispDigitalGain"] = ispDigitalGain
        }
        if let ispAnalogGain = settings.ispAnalogGain, !ispAnalogGain.isEmpty {
            json["ispAnalogGain"] = ispAnalogGain
        }
        if let aeExposureDivisor = settings.aeExposureDivisor, aeExposureDivisor > 1 {
            json["aeExposureDivisor"] = aeExposureDivisor
        }
        if let isoCap = settings.isoCap, isoCap > 0 {
            json["isoCap"] = isoCap
        }
        if let compress = settings.compress, !compress.isEmpty {
            json["compress"] = compress
        }
        if let sound = settings.sound {
            json["sound"] = sound
        }
        if settings.resetCaptureTuning == true {
            json["resetCaptureTuning"] = true
        }
        sendJson(json, wakeUp: true)
    }

    func sendButtonCameraLedSetting() {
        let enabled = DeviceStore.shared.get("bluetooth", "button_camera_led") as! Bool
        sendButtonCameraLedSetting(requestId: nil, enabled: enabled)
    }

    func sendButtonCameraLedSetting(requestId: String?, enabled: Bool) {
        Bridge.log("Sending button camera LED setting: \(enabled)")

        guard connectionState == ConnTypes.CONNECTED else {
            Bridge.log("Cannot send button camera LED setting - not connected")
            return
        }

        var json: [String: Any] = [
            "type": "button_camera_led",
            "enabled": enabled,
        ]
        if let requestId, !requestId.isEmpty {
            json["request_id"] = requestId
        }
        sendJson(json, wakeUp: true)
    }

    func sendCameraFovSetting() {
        let settings = DeviceStore.shared.get("bluetooth", "camera_fov") as? [String: Any] ?? ["fov": 118, "roi_position": 0]
        let fov = settings["fov"] as? Int ?? 118
        let roiPosition = settings["roi_position"] as? Int ?? 0
        sendCameraFovSetting(requestId: nil, fov: fov, roiPosition: roiPosition)
    }

    func sendCameraFovSetting(requestId: String?, fov: Int, roiPosition: Int) {
        Bridge.log("Sending camera FOV setting: fov=\(fov), roiPosition=\(roiPosition)")

        guard connectionState == ConnTypes.CONNECTED else {
            Bridge.log("Cannot send camera FOV setting - not connected")
            return
        }

        var json: [String: Any] = [
            "type": "camera_fov_setting",
            "params": [
                "fov": fov,
                "roi_position": roiPosition,
            ],
        ]
        if let requestId, !requestId.isEmpty {
            json["request_id"] = requestId
        }
        sendJson(json, wakeUp: true)
    }

    func startVideoRecording(requestId: String, save: Bool, flash: Bool, sound: Bool) {
        startVideoRecording(
            requestId: requestId, save: save, flash: flash, sound: sound, width: 0, height: 0, fps: 0,
            maxRecordingTimeMinutes: 0
        )
    }

    // MARK: - SGCManager Protocol Compliance

    func sendButtonMaxRecordingTime(_ minutes: Int) {
        sendButtonMaxRecordingTime(requestId: nil, minutes: minutes)
    }

    func startVideoRecording(
        requestId: String, save: Bool, flash: Bool, sound: Bool, width: Int, height: Int, fps: Int,
        maxRecordingTimeMinutes: Int
    ) {
        Bridge.log(
            "Starting video recording on glasses: requestId=\(requestId), save=\(save), flash=\(flash), sound=\(sound), resolution=\(width)x\(height)@\(fps)fps, maxRecordingTimeMinutes=\(maxRecordingTimeMinutes)"
        )

        guard connectionState == ConnTypes.CONNECTED else {
            Bridge.log("Cannot start video recording - not connected")
            return
        }

        var json: [String: Any] = [
            "type": "start_video_recording",
            "requestId": requestId,
            "save": save,
            "flash": flash,
            "sound": sound,
        ]

        // Auto-stop timer; only sent when set (> 0). 0 = record until stopped.
        if maxRecordingTimeMinutes > 0 {
            json["maxRecordingTimeMinutes"] = maxRecordingTimeMinutes
        }

        // Add video settings when any field is overridden. Each field is sent
        // only when > 0; the glasses merge the missing fields onto their saved
        // button-video defaults, so a partial override (e.g. fps-only) still
        // takes effect instead of being dropped here.
        if width > 0 || height > 0 || fps > 0 {
            var settings: [String: Any] = [:]
            if width > 0 { settings["width"] = width }
            if height > 0 { settings["height"] = height }
            if fps > 0 { settings["fps"] = fps }
            json["settings"] = settings
        }
        sendJson(json)
    }

    func stopVideoRecording(requestId: String) {
        stopVideoRecording(requestId: requestId, webhookUrl: nil, authToken: nil)
    }

    func stopVideoRecording(requestId: String, webhookUrl: String?, authToken: String?) {
        Bridge.log(
            "Stopping video recording on glasses: requestId=\(requestId), webhook=\((webhookUrl?.isEmpty ?? true) ? "none" : "set")"
        )

        guard connectionState == ConnTypes.CONNECTED else {
            Bridge.log("Cannot stop video recording - not connected")
            return
        }

        var json: [String: Any] = [
            "type": "stop_video_recording",
            "requestId": requestId,
        ]
        // Webhook upload target, supplied at stop so the token is fresh.
        // Only sent when present; empty webhook = keep video on device.
        if let webhookUrl, !webhookUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            json["webhookUrl"] = webhookUrl
        }
        if let authToken, !authToken.isEmpty {
            json["authToken"] = authToken
        }
        sendJson(json)
    }
}

// MARK: - PhoneAudioMonitorListener

extension MentraLive: PhoneAudioMonitorListener {
    /// Handle phone audio playback state changes
    /// Called by PhoneAudioMonitor when phone starts/stops playing audio
    ///
    /// State machine logic:
    /// - When phone starts playing audio: suspend LC3 mic if it was running
    /// - When phone stops playing audio: resume LC3 mic if it was suspended
    func onPhoneAudioStateChanged(isPlaying: Bool) {
        Bridge.log("LIVE: 🎵 Phone audio state changed: \(isPlaying ? "PLAYING" : "STOPPED")")

        if isPlaying {
            // Phone started playing audio - suspend mic if it was running
            if micIntentEnabled && !micSuspendedForAudio {
                Bridge.log("LIVE: 🎤 Phone audio started - suspending LC3 mic to avoid MCU overload")
                stopMicBeat()
                micSuspendedForAudio = true
            }
        } else {
            // Phone stopped playing audio - resume mic if it was suspended
            if micIntentEnabled && micSuspendedForAudio {
                Bridge.log("LIVE: 🎤 Phone audio stopped - resuming LC3 mic")
                micSuspendedForAudio = false
                startMicBeat()
            }
        }
    }
}
