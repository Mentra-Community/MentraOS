import AVKit
import CoreLocation
import ExpoModulesCore
import GoogleNavigation
import Photos

/// User-visible album in Apple Photos for glasses sync (matches dedicated-folder behavior on Android).
private enum MentraSyncedMediaAlbum {
    static let localizedTitle = "Mentra"
}

public class CrustModule: Module {
    public func definition() -> ModuleDefinition {
        Name("Crust")

        Constant("PI") {
            Double.pi
        }

        Events(
            "onChange",
            "phone_notification",
            "phone_notification_dismissed",
            "captions_tester_incident",
            "onNavManeuver",
            "onNavRerouting",
            "onNavArrived",
            "onNavError",
            "onNavOffRoute",
            "onNavLocation",
            "onNavRoute",
            "onHeading"
        )

        Function("hello") {
            "Hello world! 👋"
        }

        AsyncFunction("setValueAsync") { (value: String) in
            self.sendEvent("onChange", [
                "value": value,
            ])
        }

        AsyncFunction("requestNavigationPermission") { () -> [String: Any] in
            await withCheckedContinuation { continuation in
                NavigationManager.shared.requestPermission { accepted in
                    continuation.resume(returning: ["ok": true, "accepted": accepted])
                }
            }
        }

        AsyncFunction("startNavigation") { (lat: Double, lng: Double, options: [String: Any]?) -> [String: Any] in
            let simulate = options?["simulate"] as? Bool ?? false
            let speedMultiplier = options?["speedMultiplier"] as? Double ?? 1.0
            let mode = options?["mode"] as? String ?? "driving"

            var stops: [(lat: Double, lng: Double)] = []
            if let stopsArr = options?["stops"] as? [[String: Double]] {
                stops = stopsArr.compactMap { s in
                    guard let slat = s["lat"], let slng = s["lng"] else { return nil }
                    return (lat: slat, lng: slng)
                }
            }
            if stops.isEmpty { stops = [(lat: lat, lng: lng)] }

            return await withCheckedContinuation { continuation in
                NavigationManager.shared.start(
                    stops: stops,
                    mode: mode,
                    simulate: simulate,
                    speedMultiplier: speedMultiplier,
                    onEvent: { [weak self] payload in
                        guard let self else { return }
                        let kind = payload["kind"] as? String ?? ""
                        switch kind {
                        case "maneuver": self.sendEvent("onNavManeuver", payload)
                        case "rerouting": self.sendEvent("onNavRerouting", payload)
                        case "arrived": self.sendEvent("onNavArrived", payload)
                        case "off_route": self.sendEvent("onNavOffRoute", payload)
                        case "error": self.sendEvent("onNavError", payload)
                        default: break
                        }
                    },
                    onLocation: { [weak self] payload in
                        self?.sendEvent("onNavLocation", payload)
                    },
                    onRoute: { [weak self] payload in
                        self?.sendEvent("onNavRoute", payload)
                    }
                ) { ok, error in
                    var result: [String: Any] = ["ok": ok]
                    if let error { result["error"] = error }
                    continuation.resume(returning: result)
                }
            }
        }

        AsyncFunction("stopNavigation") { () -> [String: Any] in
            NavigationManager.shared.stop()
            return ["ok": true]
        }

        AsyncFunction("simulateDeviation") { (offsetMeters: Double?) -> [String: Any] in
            NavigationManager.shared.simulateDeviation(offsetMeters: offsetMeters ?? 50)
            return ["ok": true]
        }

        AsyncFunction("startHeading") { () -> [String: Any] in
            HeadingManager.shared.start { [weak self] degrees in
                self?.sendEvent("onHeading", ["degrees": degrees])
            }
            return ["ok": true]
        }

        AsyncFunction("stopHeading") { () -> [String: Any] in
            HeadingManager.shared.stop()
            return ["ok": true]
        }

        // Location:

        AsyncFunction("showLocationServicesDialog") { () -> Bool in
            return false
        }

        AsyncFunction("openLocationSettings") { () -> Bool in
            return false
        }

        AsyncFunction("openAppSettings") { () -> Bool in
            return false
        }

        AsyncFunction("openBluetoothSettings") { () -> Bool in
            return false
        }

        // MARK: - MentraOS Notification Commands

        AsyncFunction("setNotificationConfig") { (_: Bool, _: [String]) in
            // No-op on iOS
        }

        AsyncFunction("getInstalledApps") { () -> [[String: Any]] in
            return []
        }

        AsyncFunction("getInstalledAppsForNotifications") { () -> [[String: Any]] in
            return []
        }

        AsyncFunction("hasNotificationListenerPermission") { () -> Bool in
            return false
        }

        AsyncFunction("openNotificationListenerSettings") { () -> Bool in
            return false
        }

        // MARK: - Build Environment

        AsyncFunction("isBetaBuild") { () -> Bool in
            #if targetEnvironment(simulator)
                return false
            #else
                return Bundle.main.appStoreReceiptURL?.lastPathComponent == "sandboxReceipt"
            #endif
        }

        Function("showAVRoutePicker") { (tintColor: String?) in
            DispatchQueue.main.async {
                let picker = AVRoutePickerView()
                picker.prioritizesVideoDevices = false

                if let colorString = tintColor {
                    picker.tintColor = UIColor(hexString: colorString)
                } else {
                    picker.tintColor = .label
                }

                if let button = picker.subviews.first(where: { $0 is UIButton }) as? UIButton {
                    button.sendActions(for: .touchUpInside)
                }
            }
        }

        View(CrustView.self) {
            Prop("url") { (view: CrustView, url: URL) in
                if view.webView.url != url {
                    view.webView.load(URLRequest(url: url))
                }
            }

            Events("onLoad")
        }

        // MARK: - Image Processing Commands

        AsyncFunction("processGalleryImage") {
            (inputPath: String, outputPath: String, options: [String: Any]) -> [String: Any] in
            let lensCorrection = options["lensCorrection"] as? Bool ?? true
            let colorCorrection = options["colorCorrection"] as? Bool ?? true

            guard FileManager.default.fileExists(atPath: inputPath) else {
                return ["success": false, "error": "Input file does not exist"]
            }

            let processingTimeMs = ImageProcessor.process(
                inputPath: inputPath,
                outputPath: outputPath,
                lensCorrection: lensCorrection,
                colorCorrection: colorCorrection
            )

            if processingTimeMs >= 0 {
                return [
                    "success": true,
                    "outputPath": outputPath,
                    "processingTimeMs": processingTimeMs,
                ]
            } else {
                return ["success": false, "error": "Processing failed"]
            }
        }

        // MARK: - HDR Merge Commands

        AsyncFunction("mergeHdrBrackets") {
            (underPath: String, normalPath: String, overPath: String, outputPath: String)
            -> [String: Any] in
            let processingTimeMs = ImageProcessor.mergeHdr(
                underPath: underPath,
                normalPath: normalPath,
                overPath: overPath,
                outputPath: outputPath
            )
            if processingTimeMs >= 0 {
                return [
                    "success": true,
                    "outputPath": outputPath,
                    "processingTimeMs": processingTimeMs,
                ]
            } else {
                return ["success": false, "error": "HDR merge failed"]
            }
        }

        // MARK: - Video Stabilization Commands

        AsyncFunction("stabilizeVideo") {
            (inputPath: String, imuPath: String, outputPath: String) -> [String: Any] in
            guard FileManager.default.fileExists(atPath: inputPath) else {
                return ["success": false, "error": "Input video does not exist"]
            }
            guard FileManager.default.fileExists(atPath: imuPath) else {
                return ["success": false, "error": "IMU sidecar does not exist"]
            }

            let processingTimeMs = VideoStabilizer.stabilize(
                inputPath: inputPath,
                imuPath: imuPath,
                outputPath: outputPath
            )

            if processingTimeMs >= 0 {
                return [
                    "success": true,
                    "outputPath": outputPath,
                    "processingTimeMs": processingTimeMs,
                ]
            } else {
                return ["success": false, "error": "Stabilization failed"]
            }
        }

        // MARK: - Media Library Commands

        AsyncFunction("saveToGalleryWithDate") {
            (filePath: String, captureTimeMillis: Int64?) -> [String: Any] in
            let fileURL = URL(fileURLWithPath: filePath)

            guard FileManager.default.fileExists(atPath: filePath) else {
                return ["success": false, "error": "File does not exist"]
            }

            var assetIdentifier: String?
            let semaphore = DispatchSemaphore(value: 0)
            var resultError: Error?
            var creationFailed = false

            PHPhotoLibrary.shared().performChanges {
                let pathExtension = fileURL.pathExtension.lowercased()

                let creationRequest: PHAssetChangeRequest
                if ["mp4", "mov", "avi", "m4v"].contains(pathExtension) {
                    guard let req = PHAssetChangeRequest.creationRequestForAssetFromVideo(
                        atFileURL: fileURL
                    )
                    else {
                        NSLog("CrustModule: Failed to create video asset request for: \(filePath)")
                        creationFailed = true
                        return
                    }
                    creationRequest = req
                } else {
                    guard let req = PHAssetChangeRequest.creationRequestForAssetFromImage(
                        atFileURL: fileURL
                    )
                    else {
                        NSLog("CrustModule: Failed to create image asset request for: \(filePath)")
                        creationFailed = true
                        return
                    }
                    creationRequest = req
                }

                if let captureMillis = captureTimeMillis {
                    let captureDate = Date(
                        timeIntervalSince1970: TimeInterval(captureMillis) / 1000.0
                    )
                    creationRequest.creationDate = captureDate
                    NSLog("CrustModule: Setting creation date to: \(captureDate)")
                }

                guard let assetPlaceholder = creationRequest.placeholderForCreatedAsset else {
                    NSLog("CrustModule: Missing placeholder for created asset")
                    creationFailed = true
                    return
                }

                assetIdentifier = assetPlaceholder.localIdentifier

                let albumFetch = PHFetchOptions()
                albumFetch.predicate = NSPredicate(
                    format: "localizedTitle == %@", MentraSyncedMediaAlbum.localizedTitle
                )
                albumFetch.fetchLimit = 1

                let existingAlbums = PHAssetCollection.fetchAssetCollections(
                    with: .album,
                    subtype: .albumRegular,
                    options: albumFetch
                )

                if let album = existingAlbums.firstObject,
                   let albumChange = PHAssetCollectionChangeRequest(for: album)
                {
                    albumChange.addAssets([assetPlaceholder] as NSArray)
                } else if existingAlbums.firstObject == nil {
                    let newAlbumChange = PHAssetCollectionChangeRequest.creationRequestForAssetCollection(
                        withTitle: MentraSyncedMediaAlbum.localizedTitle
                    )
                    newAlbumChange.addAssets([assetPlaceholder] as NSArray)
                } else {
                    NSLog(
                        "CrustModule: Mentra album exists but is not writable; asset saved to library only"
                    )
                }
            } completionHandler: { _, error in
                resultError = error
                semaphore.signal()
            }

            semaphore.wait()

            if creationFailed {
                return ["success": false, "error": "Failed to create asset request - file may be corrupted or unsupported"]
            }

            if let error = resultError {
                NSLog("CrustModule: Error saving to gallery: \(error.localizedDescription)")
                return ["success": false, "error": error.localizedDescription]
            }

            NSLog("CrustModule: Successfully saved to gallery with proper creation date")
            return ["success": true, "identifier": assetIdentifier ?? ""]
        }

    }
}

extension UIColor {
    convenience init?(hexString: String) {
        var hex = hexString.trimmingCharacters(in: .whitespacesAndNewlines)
        hex = hex.replacingOccurrences(of: "#", with: "")

        var rgb: UInt64 = 0
        guard Scanner(string: hex).scanHexInt64(&rgb) else { return nil }

        let length = hex.count
        let r, g, b, a: CGFloat

        if length == 6 {
            r = CGFloat((rgb & 0xFF0000) >> 16) / 255.0
            g = CGFloat((rgb & 0x00FF00) >> 8) / 255.0
            b = CGFloat(rgb & 0x0000FF) / 255.0
            a = 1.0
        } else if length == 8 {
            r = CGFloat((rgb & 0xFF00_0000) >> 24) / 255.0
            g = CGFloat((rgb & 0x00FF_0000) >> 16) / 255.0
            b = CGFloat((rgb & 0x0000_FF00) >> 8) / 255.0
            a = CGFloat(rgb & 0x0000_00FF) / 255.0
        } else {
            return nil
        }

        self.init(red: r, green: g, blue: b, alpha: a)
    }
}
