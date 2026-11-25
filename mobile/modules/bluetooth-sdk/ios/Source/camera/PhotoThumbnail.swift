import Foundation
import ImageIO
import UniformTypeIdentifiers

/// A small copy of a full photo, made on the phone: a JPEG at most `PhotoThumbnails.maxSide` px on
/// its long side, upright (EXIF orientation applied), next to the photo in the app's cache folder.
/// Like the photo, it is the caller's to move or delete.
public struct PhotoThumbnail: Equatable {
    /// A `file://` URL.
    public let url: String
    public let width: Int
    public let height: Int
    public let mimeType: String
    /// The file's size in bytes.
    public let size: Int

    public init(url: String, width: Int, height: Int, mimeType: String = "image/jpeg", size: Int) {
        self.url = url
        self.width = width
        self.height = height
        self.mimeType = mimeType
        self.size = size
    }

    public var values: [String: Any] {
        ["fileUri": url, "width": width, "height": height, "mimeType": mimeType, "size": size]
    }
}

/// Makes `PhotoThumbnail`s without decoding the full photo.
public enum PhotoThumbnails {
    public static let maxSide = 512
    public static let jpegQuality = 0.8

    /// The thumbnail's file for the photo at `photo`: beside it, with `.thumb.jpg` in place of its extension.
    public static func fileURL(for photo: URL) -> URL {
        photo.deletingPathExtension().appendingPathExtension("thumb.jpg")
    }

    /// The thumbnail of the photo at `photoUrl` (a `file://` URL or a path), or nil when it isn't a
    /// readable image. ImageIO decodes at the thumbnail's size, not the full photo's, and applies the
    /// EXIF orientation.
    public static func make(_ photoUrl: String) -> PhotoThumbnail? {
        let photo = photoUrl.hasPrefix("file:") ? URL(string: photoUrl) : URL(fileURLWithPath: photoUrl)
        guard let photo, photo.isFileURL,
              let source = CGImageSourceCreateWithURL(photo as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary)
        else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxSide,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        let out = fileURL(for: photo)
        guard let destination = CGImageDestinationCreateWithURL(out as CFURL, UTType.jpeg.identifier as CFString, 1, nil)
        else { return nil }
        CGImageDestinationAddImage(
            destination,
            image,
            [kCGImageDestinationLossyCompressionQuality: jpegQuality] as CFDictionary
        )
        guard CGImageDestinationFinalize(destination) else {
            try? FileManager.default.removeItem(at: out)
            return nil
        }
        let size = (try? FileManager.default.attributesOfItem(atPath: out.path)[.size] as? NSNumber)?.intValue ?? 0
        return PhotoThumbnail(url: out.absoluteString, width: image.width, height: image.height, size: size)
    }
}
