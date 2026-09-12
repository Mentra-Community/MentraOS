import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Decode upright pixels once, so bitmap rendering and JPEG encoding agree on both Apple platforms.
struct SdkImage {
    let cgImage: CGImage?
    var size: CGSize {
        CGSize(width: cgImage?.width ?? 0, height: cgImage?.height ?? 0)
    }

    init?(data: Data) {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int,
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                  kCGImageSourceCreateThumbnailFromImageAlways: true,
                  kCGImageSourceCreateThumbnailWithTransform: true,
                  kCGImageSourceThumbnailMaxPixelSize: max(width, height),
              ] as CFDictionary)
        else { return nil }
        cgImage = image
    }

    func jpegData(compressionQuality: CGFloat) -> Data? {
        guard let cgImage else { return nil }
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil)
        else { return nil }
        CGImageDestinationAddImage(destination, cgImage, [
            kCGImageDestinationLossyCompressionQuality: compressionQuality,
            kCGImagePropertyOrientation: 1,
        ] as CFDictionary)
        return CGImageDestinationFinalize(destination) ? data as Data : nil
    }
}
