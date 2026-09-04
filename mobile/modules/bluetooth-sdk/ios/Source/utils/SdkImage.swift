import Foundation

#if os(macOS)
    import ImageIO
    import UniformTypeIdentifiers

    /// Image decoding and JPEG encoding without a UI framework dependency on macOS.
    struct SdkImage {
        let cgImage: CGImage?
        private let orientation: Int?
        var size: CGSize {
            CGSize(width: cgImage?.width ?? 0, height: cgImage?.height ?? 0)
        }

        init?(data: Data) {
            guard let source = CGImageSourceCreateWithData(data as CFData, nil),
                  let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
            else { return nil }
            cgImage = image
            let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
            orientation = properties?[kCGImagePropertyOrientation] as? Int
        }

        func jpegData(compressionQuality: CGFloat) -> Data? {
            guard let cgImage else { return nil }
            let data = NSMutableData()
            guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil)
            else { return nil }
            var properties: [CFString: Any] = [
                kCGImageDestinationLossyCompressionQuality: compressionQuality,
            ]
            if let orientation { properties[kCGImagePropertyOrientation] = orientation }
            CGImageDestinationAddImage(destination, cgImage, properties as CFDictionary)
            return CGImageDestinationFinalize(destination) ? data as Data : nil
        }
    }
#else
    import UIKit

    typealias SdkImage = UIImage
#endif
