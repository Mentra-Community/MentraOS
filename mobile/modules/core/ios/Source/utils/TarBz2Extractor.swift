import Compression
import Foundation
import libbz2
import SWCompression

@objc(TarBz2Extractor)
public class TarBz2Extractor: NSObject {
    private static let chunkSize = 1 << 16 // 64 KB

    @objc
    public static func extractTarBz2From(
        _ sourcePath: String,
        to destinationPath: String,
        error errorPointer: NSErrorPointer
    ) -> Bool {
        Bridge.log("TarBz2Extractor: begin extraction")
        do {
            try performExtraction(from: sourcePath, to: destinationPath)
            Bridge.log("TarBz2Extractor: extraction complete")
            return true
        } catch let extractionError as NSError {
            Bridge.log("TarBz2Extractor: failed - \(extractionError.localizedDescription)")
            errorPointer?.pointee = extractionError
            return false
        } catch {
            let nsError = NSError(
                domain: "TarBz2Extractor",
                code: -1,
                userInfo: [NSLocalizedDescriptionKey: error.localizedDescription]
            )
            Bridge.log("TarBz2Extractor: failed - \(error.localizedDescription)")
            errorPointer?.pointee = nsError
            return false
        }
    }

    private static func performExtraction(from sourcePath: String, to destinationPath: String) throws {
        let fileManager = FileManager.default
        try fileManager.createDirectory(
            atPath: destinationPath,
            withIntermediateDirectories: true,
            attributes: nil
        )

        let tempTarURL = try decompressBzipArchive(at: sourcePath)
        defer { try? fileManager.removeItem(at: tempTarURL) }

        try extractTarArchive(at: tempTarURL, to: destinationPath)
        try flattenNestedDirectory(at: destinationPath)
    }

    private static func decompressBzipArchive(at sourcePath: String) throws -> URL {
        let tempTarURL = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension("tar")

        guard let sourceFile = fopen(sourcePath, "rb") else {
            throw makeError(code: 1001, message: "Unable to open source file at \(sourcePath)")
        }
        defer { fclose(sourceFile) }

        guard let destinationFile = fopen(tempTarURL.path, "wb") else {
            throw makeError(code: 1002, message: "Unable to create temporary tar file")
        }
        defer { fclose(destinationFile) }

        var bzError: Int32 = BZ_OK
        guard let bzFile = BZ2_bzReadOpen(&bzError, sourceFile, 0, 0, nil, 0), bzError == BZ_OK else {
            throw makeError(code: 1003, message: "Unable to open bzip stream (code \(bzError))")
        }

        var buffer = [Int8](repeating: 0, count: chunkSize)
        while true {
            let bytesRead = BZ2_bzRead(&bzError, bzFile, &buffer, Int32(buffer.count))
            if bzError == BZ_OK || bzError == BZ_STREAM_END {
                if bytesRead > 0 {
                    let written = buffer.withUnsafeBytes { rawBuffer -> Int in
                        guard let baseAddress = rawBuffer.baseAddress else { return 0 }
                        return fwrite(baseAddress, 1, Int(bytesRead), destinationFile)
                    }
                    guard written == Int(bytesRead) else {
                        BZ2_bzReadClose(&bzError, bzFile)
                        throw makeError(code: 1004, message: "Failed to write decompressed data")
                    }
                }
                if bzError == BZ_STREAM_END {
                    break
                }
            } else {
                BZ2_bzReadClose(&bzError, bzFile)
                throw makeError(code: 1005, message: "bzip2 read failed with code \(bzError)")
            }
        }

        BZ2_bzReadClose(&bzError, bzFile)
        guard bzError == BZ_OK else {
            throw makeError(code: 1006, message: "bzip2 close failed with code \(bzError)")
        }

        return tempTarURL
    }

    private static func extractTarArchive(at tarURL: URL, to destinationPath: String) throws {
        let destinationRoot = URL(fileURLWithPath: destinationPath, isDirectory: true)
        let fileManager = FileManager.default

        let handle = try FileHandle(forReadingFrom: tarURL)
        defer { try? handle.close() }

        var reader = TarReader(fileHandle: handle)

        while let entry = try reader.read() {
            let sanitizedName = sanitize(entryName: entry.info.name)
            if sanitizedName.isEmpty {
                continue
            }

            let entryURL = destinationRoot.appendingPathComponent(sanitizedName)
            switch entry.info.type {
            case .directory:
                try fileManager.createDirectory(
                    at: entryURL,
                    withIntermediateDirectories: true,
                    attributes: nil
                )
            case .regular:
                guard let data = entry.data else { continue }
                try fileManager.createDirectory(
                    at: entryURL.deletingLastPathComponent(),
                    withIntermediateDirectories: true,
                    attributes: nil
                )
                let finalURL = remapModelFileIfNeeded(for: entryURL)
                try data.write(to: finalURL, options: .atomic)
            default:
                continue
            }
        }
    }

    private static func flattenNestedDirectory(at destinationPath: String) throws {
        let fileManager = FileManager.default
        let destinationURL = URL(fileURLWithPath: destinationPath, isDirectory: true)
        let nestedURL = destinationURL.appendingPathComponent(destinationURL.lastPathComponent)

        guard fileManager.fileExists(atPath: nestedURL.path) else { return }

        let nestedFiles = try fileManager.contentsOfDirectory(at: nestedURL, includingPropertiesForKeys: nil)
        for file in nestedFiles {
            let target = destinationURL.appendingPathComponent(file.lastPathComponent)
            if fileManager.fileExists(atPath: target.path) {
                try fileManager.removeItem(at: target)
            }
            try fileManager.moveItem(at: file, to: target)
        }

        try fileManager.removeItem(at: nestedURL)
    }

    private static func sanitize(entryName: String) -> String {
        var name = entryName

        if name.hasPrefix("./") {
            name.removeFirst(2)
        }
        while name.hasPrefix("/") {
            name.removeFirst()
        }

        guard !name.isEmpty else { return "" }

        var components = name.split(separator: "/").map(String.init)
        guard !components.isEmpty else { return "" }

        if components.count > 1 {
            components.removeFirst()
            name = components.joined(separator: "/")
        } else {
            name = components[0]
        }

        return name
    }

    private static func remapModelFileIfNeeded(for url: URL) -> URL {
        let parent = url.deletingLastPathComponent()
        switch url.lastPathComponent {
        case "encoder-epoch-99-avg-1.onnx":
            return parent.appendingPathComponent("encoder.onnx")
        case "decoder-epoch-99-avg-1.onnx":
            return parent.appendingPathComponent("decoder.onnx")
        case "joiner-epoch-99-avg-1.int8.onnx":
            return parent.appendingPathComponent("joiner.onnx")
        default:
            return url
        }
    }

    private static func makeError(code: Int, message: String) -> NSError {
        return NSError(
            domain: "TarBz2Extractor",
            code: code,
            userInfo: [NSLocalizedDescriptionKey: message]
        )
    }
}
