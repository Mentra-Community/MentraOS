import Foundation
import zlib

/// Dynamic Layout V1, shared with the Android NIMO adapter. All limits are checked
/// before sending anything; an invalid scene leaves the last accepted scene intact.
enum NimoCanvasCodec {
    static let width = 500
    static let height = 220
    static let maxStream = 12288
    static let appId = 0xFD
    static let lineHeight = 20

    enum Invalid: Error { case value(String) }

    static func require(_ condition: Bool, _ message: String = "Invalid canvas value") throws {
        if !condition { throw Invalid.value(message) }
    }

    struct Object {
        let type: Int
        let payload: Data
        var textBytes = 0
        var pixels = 0
    }

    static func imageBytes(_ input: String) throws -> Data {
        try require(input.utf8.count <= 2_800_000, "Encoded image exceeds limit")
        var encoded = input
        var mime: String?
        for kind in ["png", "bmp"] where input.hasPrefix("data:image/\(kind);base64,") {
            mime = kind
            encoded = String(input.dropFirst("data:image/\(kind);base64,".count))
        }
        try require(!input.hasPrefix("data:") || mime != nil, "Unsupported image data URI")
        try require(encoded.utf8.count % 4 == 0, "Base64 must be padded")
        guard let data = Data(base64Encoded: encoded) else { throw Invalid.value("Invalid Base64") }
        try require((24 ... 2_000_000).contains(data.count), "Image file exceeds limit")
        let png = data.prefix(8) == Data([0x89, 0x50, 0x4E, 0x47, 13, 10, 26, 10])
        let bmp = data.count >= 54 && data.prefix(2) == Data([0x42, 0x4D])
        try require((png && mime != "bmp") || (bmp && mime != "png"), "Image must be PNG or BMP matching its MIME type")
        return data
    }

    static func region(_ x: Int, _ y: Int, _ w: Int, _ h: Int) throws {
        try require((0 ..< width).contains(x) && (0 ..< height).contains(y)
            && (1 ... width).contains(w) && (1 ... height).contains(h))
        try require(x + w <= width && y + h <= height, "Region exceeds 500x220")
    }

    static func line(_ x0: Int, _ y0: Int, _ x1: Int, _ y1: Int, stroke: Int = 1, intensity: Int = 255) throws -> Object {
        try region(x0, y0, 1, 1)
        try region(x1, y1, 1, 1)
        try require((1 ... 32).contains(stroke) && (0 ... 255).contains(intensity))
        return Object(type: 0, payload: words(x0, y0, x1, y1) + bytes(stroke, intensity))
    }

    static func rectangle(_ x: Int, _ y: Int, _ w: Int, _ h: Int, stroke: Int = 1,
                          radius: Int = 0, intensity: Int = 255, filled: Bool = false) throws -> Object
    {
        try region(x, y, w, h)
        try require((0 ... 32).contains(stroke) && (0 ... 255).contains(radius) && (0 ... 255).contains(intensity))
        return Object(type: 1, payload: words(x, y, w, h) + bytes(stroke, radius, intensity, filled ? 1 : 0))
    }

    static func circle(_ x: Int, _ y: Int, radius: Int, stroke: Int = 1, intensity: Int = 255, filled: Bool = false) throws -> Object {
        try require((1 ... 110).contains(radius))
        try region(x, y, 1, 1)
        try require(x - radius >= 0 && y - radius >= 0 && x + radius < width && y + radius < height)
        try require((0 ... 32).contains(stroke) && (0 ... 255).contains(intensity))
        return Object(type: 2, payload: words(x, y, radius) + bytes(stroke, intensity, filled ? 1 : 0))
    }

    static func label(_ text: String, _ x: Int, _ y: Int, _ w: Int, _ h: Int,
                      font: Int = 0, language: Int = 0, intensity: Int = 255) throws -> Object
    {
        try region(x, y, w, h)
        try require((0 ... 3).contains(font) && (0 ... 20).contains(language) && (0 ... 255).contains(intensity))
        let utf8 = Data(text.utf8)
        try require((1 ... 2048).contains(utf8.count) && !utf8.contains(0), "Label exceeds 2048 UTF-8 bytes or contains NUL")
        return Object(type: 3, payload: words(x, y, w, h, language) + bytes(font, intensity) + words(utf8.count) + utf8,
                      textBytes: utf8.count)
    }

    /// Empty rows still consume vertical space. The host already wrapped each row.
    static func textRows(_ text: String, _ x: Int, _ y: Int, _ w: Int, _ h: Int) throws -> [Object] {
        try region(x, y, w, h)
        try require(text.utf16.count <= 8192 && !text.utf8.contains(0))
        let rows = text.components(separatedBy: "\n")
        try require(rows.count <= 64)
        return try rows.enumerated().compactMap { index, row in
            let offset = index * lineHeight
            guard offset < h, !row.isEmpty else { return nil }
            return try label(row, x, y + offset, w, min(lineHeight, h - offset))
        }
    }

    static func text(_ text: String, _ x: Int, _ y: Int, _ w: Int, _ h: Int, border: Int, radius: Int) throws -> [Object] {
        try region(x, y, w, h)
        try require((0 ... 32).contains(border) && (0 ... 255).contains(radius))
        var objects: [Object] = []
        if border > 0 { try objects.append(rectangle(x, y, w, h, stroke: border, radius: radius)) }
        if !text.isEmpty, !text.contains("\n") {
            try objects.append(label(text, x, y, w, h))
        } else {
            objects += try textRows(text, x, y, w, h)
        }
        return objects
    }

    /// 00=white, 11=black. Pack continuously across rows; pad with black.
    static func pack2(_ gray: Data) throws -> Data {
        try require((1 ... 110_000).contains(gray.count))
        var output = Data(repeating: 0xFF, count: (gray.count + 3) / 4)
        for (i, value) in gray.enumerated() {
            let shift = 6 - 2 * (i % 4)
            let code = min(3, (255 - Int(value) + 42) / 85)
            output[i / 4] = (output[i / 4] & ~UInt8(3 << shift)) | UInt8(code << shift)
        }
        return output
    }

    static func rle(_ data: Data) throws -> Data {
        try require(data.count <= 110_000)
        let input = [UInt8](data)
        var output = Data()
        var i = 0
        func run(_ start: Int) -> Int {
            var n = 1
            while start + n < input.count, n < 127, input[start + n] == input[start] {
                n += 1
            }
            return n
        }
        while i < input.count {
            let count = run(i)
            if count >= 3 {
                output.append(contentsOf: [UInt8(count), input[i]])
                i += count
            } else {
                let start = i
                i += count
                while i < input.count, i - start < 127 {
                    let next = run(i)
                    if next >= 3 { break }
                    i += min(next, 127 - (i - start))
                }
                output.append(UInt8(0x80 | (i - start)))
                output.append(contentsOf: input[start ..< i])
            }
        }
        return output
    }

    static func bitmap(_ x: Int, _ y: Int, _ w: Int, _ h: Int, gray: Data) throws -> Object {
        try region(x, y, w, h)
        try require(gray.count == w * h)
        let packed = try pack2(gray)
        let runs = try rle(packed)
        let compressed = try zlib(packed)
        let compression = runs.count <= compressed.count ? 3 : 7
        let body = compression == 3 ? runs : compressed
        let packet = bytes(0) + words(w, h) + bytes(2, compression) + dword(packed.count) + dword(body.count) + body
        try require(packet.count <= 65535)
        return Object(type: 4, payload: words(x, y, w, h, 0, 1, packet.count) + packet, pixels: gray.count)
    }

    static func scene(_ elements: [SceneElement], decodeImage: (String, Int, Int) throws -> Data) throws -> Data {
        try require(elements.count <= 64)
        var pixels = 0
        // Validate every region and the aggregate image budget before decoding any image.
        for e in elements {
            try region(Int(e.x), Int(e.y), Int(e.w), Int(e.h))
            try require(["text", "rect", "image"].contains(e.type)
                && (0 ... 32).contains(e.border) && (0 ... 255).contains(e.radius))
            if e.type == "image" {
                try require(e.data != nil)
                pixels += Int(e.w) * Int(e.h)
                try require(pixels <= 110_000, "Frame exceeds image pixel budget")
            }
        }
        var objects: [Object] = []
        for e in elements {
            let (x, y, w, h) = (Int(e.x), Int(e.y), Int(e.w), Int(e.h))
            switch e.type {
            case "text":
                if e.border > 0 { try objects.append(rectangle(x, y, w, h, stroke: Int(e.border), radius: Int(e.radius))) }
                objects += try textRows(e.text ?? "", x, y, w, h)
            case "rect": try objects.append(rectangle(x, y, w, h, stroke: max(1, Int(e.border)), radius: Int(e.radius)))
            case "image": try objects.append(bitmap(x, y, w, h, gray: decodeImage(e.data!, w, h)))
            default: break // Validated above.
            }
            try require(objects.count <= 64)
        }
        return try replace(objects)
    }

    static func replace(_ objects: [Object]) throws -> Data {
        try require(objects.count <= 64, "More than 64 canvas objects")
        try require(objects.reduce(0) { $0 + $1.textBytes } <= 8192, "Frame text exceeds 8192 bytes")
        try require(objects.reduce(0) { $0 + $1.pixels } <= 110_000, "Frame exceeds image pixel budget")
        try require(3 + objects.reduce(0) { $0 + 3 + $1.payload.count } <= maxStream - 8, "Frame exceeds reassembly budget")
        var output = words(objects.count) + bytes(1)
        for object in objects {
            try require((0 ... 4).contains(object.type))
            output += bytes(object.type) + words(object.payload.count) + object.payload
        }
        return output
    }

    static func frames(key: Int, content: Data = Data(), writeCapacity: Int) throws -> [Data] {
        try require((20 ... 512).contains(writeCapacity))
        let payload: Data
        switch key {
        case 1: payload = bytes(appId, 0)
        case 3: payload = bytes(appId)
        case 4: payload = bytes(appId, 0, 0, 0) + content
        default: throw Invalid.value("Unsupported canvas command")
        }
        try require(payload.count + 4 <= maxStream)
        let stream = bytes(7, key) + words(payload.count) + payload
        let chunkSize = writeCapacity - 8
        let count = (stream.count + chunkSize - 1) / chunkSize
        return (0 ..< count).map { index in
            let chunk = stream.subdata(in: index * chunkSize ..< min(stream.count, (index + 1) * chunkSize))
            return bytes(0xBF, 0) + words(chunk.count, Int(nimoCrc16(chunk)), index == count - 1 ? 0 : index + 1) + chunk
        }
    }

    /// Canvas responses count the status byte in the application payload length.
    static func response(_ packet: Data) -> (key: Int, payload: Data)? {
        let packet = Data(packet)
        guard packet.count >= 13, packet[0] == 0xBF, packet[1] == 0 else { return nil }
        func word(_ i: Int) -> Int {
            Int(packet[i]) | (Int(packet[i + 1]) << 8)
        }
        guard word(2) == packet.count - 8, word(6) == 0, packet[8] == 7,
              word(4) == Int(nimoCrc16(packet.subdata(in: 8 ..< packet.count))),
              word(10) == packet.count - 12, [1, 3, 4].contains(Int(packet[9])) else { return nil }
        return (Int(packet[9]), packet.subdata(in: 12 ..< packet.count))
    }

    private static func zlib(_ input: Data) throws -> Data {
        var size = compressBound(uLong(input.count))
        var output = Data(count: Int(size))
        let status = output.withUnsafeMutableBytes { dst in
            input.withUnsafeBytes { src in
                compress2(dst.bindMemory(to: UInt8.self).baseAddress!, &size,
                          src.bindMemory(to: UInt8.self).baseAddress!, uLong(input.count), 6)
            }
        }
        try require(status == Z_OK, "Image compression failed")
        output.count = Int(size)
        return output
    }

    private static func bytes(_ values: Int...) -> Data {
        Data(values.map { UInt8(truncatingIfNeeded: $0) })
    }

    private static func words(_ values: Int...) -> Data {
        Data(values.flatMap { [UInt8(truncatingIfNeeded: $0), UInt8(truncatingIfNeeded: $0 >> 8)] })
    }

    private static func dword(_ value: Int) -> Data {
        bytes(value, value >> 8, value >> 16, value >> 24)
    }
}
