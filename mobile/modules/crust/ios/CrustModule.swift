import AVKit
import CoreLocation
import ExpoModulesCore
import Photos

/// User-visible album in Apple Photos for glasses sync (matches dedicated-folder behavior on Android).
private enum MentraSyncedMediaAlbum {
    static let localizedTitle = "Mentra"
}

/// Serializes callback and timeout delivery for PhotoKit APIs that may call back more than once.
private final class CheckedContinuationGate<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Value, Never>?

    init(_ continuation: CheckedContinuation<Value, Never>) {
        self.continuation = continuation
    }

    func resume(returning value: Value) {
        lock.lock()
        guard let continuation else {
            lock.unlock()
            return
        }
        self.continuation = nil
        lock.unlock()
        continuation.resume(returning: value)
    }
}

private final class PhotoLibrarySaveState: @unchecked Sendable {
    private let lock = NSLock()
    private var assetIdentifier: String?
    private var creationFailed = false

    func setAssetIdentifier(_ identifier: String) {
        lock.lock()
        assetIdentifier = identifier
        lock.unlock()
    }

    func markCreationFailed() {
        lock.lock()
        creationFailed = true
        lock.unlock()
    }

    func snapshot() -> (assetIdentifier: String?, creationFailed: Bool) {
        lock.lock()
        defer { lock.unlock() }
        return (assetIdentifier, creationFailed)
    }
}

private struct PhotoLibrarySaveResult {
    let succeeded: Bool
    let assetIdentifier: String?
    let creationFailed: Bool
    let errorMessage: String?
    let timedOut: Bool
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
            "onHeading",
            // MentraJS — fires whenever a per-miniapp JSContext calls
            // __dispatch(iface, method, args). RN-side MentraJSRouter
            // subscribes to route by packageName.
            "mentrajs_message"
        )

        OnCreate {
            // Wire the JSCRuntime's outbound event sink to the Expo
            // event emitter. The JSCDispatcher fires `forwardToRn` for
            // anything that isn't a built-in route (localStorage, fetch,
            // crypto.getRandomBytes, __runtime.ready), and the runtime's
            // exception/log/error handlers route through the same sink.
            JSCRuntime.shared.onOutbound = { [weak self] message in
                self?.sendEvent("mentrajs_message", message.payload)
            }
            // Install the polyfill bridge once, lazily on first module
            // creation. JSCPolyfillBridge.install is idempotent.
            JSCPolyfillBridge.install(into: JSCRuntime.shared.dispatcherTable)
        }

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
                // NavigationManager is @MainActor-isolated; hop onto the main
                // actor before touching it from this nonisolated AsyncFunction.
                Task { @MainActor in
                    NavigationManager.shared.requestPermission { accepted in
                        continuation.resume(returning: ["ok": true, "accepted": accepted])
                    }
                }
            }
        }

        // Mapbox has no Terms & Conditions dialog (that was Google-specific),
        // so there's nothing to reset. No-op for parity with Android, whose
        // resetTermsAccepted is also a Mapbox no-op. Returns ok:true since the
        // "reset" is trivially satisfied (no accepted-terms state exists).
        AsyncFunction("resetNavigationPermission") { () -> [String: Any] in
            return ["ok": true]
        }

        AsyncFunction("startNavigation") { (lat: Double, lng: Double, options: [String: Any]?) -> [String: Any] in
            let simulate = options?["simulate"] as? Bool ?? false
            let speedMultiplier = options?["speedMultiplier"] as? Double ?? 1.0
            let mode = options?["mode"] as? String ?? "driving"
            // Opt-in: when > 0, the NavigationManager forces a reroute as
            // soon as the user is this many meters past a pivot they
            // didn't take. nil disables the check entirely.
            let missedTurnRerouteMeters: Double? = {
                if let d = options?["missedTurnRerouteMeters"] as? Double { return d > 0 ? d : nil }
                if let i = options?["missedTurnRerouteMeters"] as? Int { return i > 0 ? Double(i) : nil }
                return nil
            }()

            var stops: [(lat: Double, lng: Double)] = []
            if let stopsArr = options?["stops"] as? [[String: Double]] {
                stops = stopsArr.compactMap { s in
                    guard let slat = s["lat"], let slng = s["lng"] else { return nil }
                    return (lat: slat, lng: slng)
                }
            }
            if stops.isEmpty { stops = [(lat: lat, lng: lng)] }

            return await withCheckedContinuation { continuation in
              // NavigationManager is @MainActor-isolated; hop onto the main actor
              // before calling start() from this nonisolated AsyncFunction.
              Task { @MainActor in
                NavigationManager.shared.start(
                    stops: stops,
                    mode: mode,
                    simulate: simulate,
                    speedMultiplier: speedMultiplier,
                    missedTurnRerouteMeters: missedTurnRerouteMeters,
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
        }

        AsyncFunction("stopNavigation") { () -> [String: Any] in
            await MainActor.run { NavigationManager.shared.stop() }
            return ["ok": true]
        }

        AsyncFunction("simulateDeviation") { (offsetMeters: Double?) -> [String: Any] in
            await MainActor.run { NavigationManager.shared.simulateDeviation(offsetMeters: offsetMeters ?? 50) }
            return ["ok": true]
        }

        // iOS doesn't implement the dev toggles yet. Return an explicit
        // error so the JS side can surface "not supported" instead of
        // silently believing the call succeeded.
        AsyncFunction("setWrongSidewalkOffset") { (_: Bool) -> [String: Any] in
            return ["ok": false, "error": "Not implemented on iOS"]
        }
        AsyncFunction("setSkipCrossings") { (_: Bool) -> [String: Any] in
            return ["ok": false, "error": "Not implemented on iOS"]
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

        // MARK: - MentraJS Runtime

        /// Spawn a per-miniapp JS context. Re-spawn is allowed: a live
        /// context with the same packageName is killed first.
        /// Returns true if the polyfill + miniapp source evaluated without
        /// throwing. On failure the context is torn down.
        AsyncFunction("mentraJsSpawn") { (packageName: String, polyfillBundle: String, miniappJs: String) -> Bool in
            return JSCRuntime.shared.spawn(
                packageName: packageName,
                polyfillBundle: polyfillBundle,
                miniappJs: miniappJs
            )
        }

        /// Evaluate an arbitrary script inside the named context. Returns
        /// the JS return value bridged to a JSON-friendly Swift type, or
        /// nil if the context is dead / eval threw. Mostly for dev tooling
        /// + tests; production code paths use mentraJsDispatchToJs.
        AsyncFunction("mentraJsEvaluate") { (packageName: String, source: String) -> Any? in
            return JSCRuntime.shared.evaluate(packageName: packageName, source: source)
        }

        /// Tear down a JS context. Cancels timers, drops refs, forces GC.
        AsyncFunction("mentraJsKill") { (packageName: String) -> Void in
            JSCRuntime.shared.kill(packageName: packageName)
        }

        /// Push an event / response envelope into the named context's
        /// globalThis.__deliver. Used by MentraJSRouter for
        /// glasses-status broadcasts and request/response correlation.
        AsyncFunction("mentraJsDispatchToJs") { (packageName: String, envelope: [String: Any]) -> Void in
            JSCRuntime.shared.dispatchToJs(packageName: packageName, envelope: envelope)
        }

        /// Set the installed manifest for a miniapp so the dispatcher's
        /// permission gate can authorize sensitive `__dispatch` calls.
        AsyncFunction("mentraJsSetManifest") { (packageName: String, permissions: [String]) -> Void in
            JSCRuntime.shared.dispatcherTable.setManifest(
                packageName: packageName,
                manifest: InstalledMiniappManifest(permissions: Set(permissions))
            )
        }

        /// Diagnostic: list all live packageNames.
        Function("mentraJsAlivePackages") { () -> [String] in
            return JSCRuntime.shared.alivePackages()
        }

        /// Diagnostic: force a JSC garbage collection cycle on the named
        /// context. Used by memory-leak hunts + tests. Returns false when
        /// the context is dead.
        AsyncFunction("mentraJsDebugForceGC") { (packageName: String) -> Bool in
            return JSCRuntime.shared.debugForceGC(packageName: packageName)
        }

        /// Read the bundled MentraJS polyfill (startup.js) from the iOS
        /// pod's resource bundle. The host calls this once on app boot,
        /// caches the string, and passes it to every mentraJsSpawn so
        /// every JSContext starts with the same polyfill ABI.
        Function("mentraJsLoadPolyfillBundle") { () -> String in
            return JSCRuntime.loadPolyfillBundle()
        }

        // MARK: - Build Environment

        AsyncFunction("isBetaBuild") { () -> Bool in
            #if targetEnvironment(simulator)
                return false
            #else
                return Bundle.main.appStoreReceiptURL?.lastPathComponent == "sandboxReceipt"
            #endif
        }

        // Configure which screen edges defer iOS system gestures
        // (Control Center, Notification Center, Home indicator). Edge
        // strings: "top", "bottom", "left", "right", "all". An empty
        // array restores default behavior. iOS-only; Android is a no-op.
        AsyncFunction("setDeferredSystemGestures") { (edges: [String]) -> Void in
            var rect: UIRectEdge = []
            for edge in edges {
                switch edge.lowercased() {
                case "top": rect.insert(.top)
                case "bottom": rect.insert(.bottom)
                case "left": rect.insert(.left)
                case "right": rect.insert(.right)
                case "all": rect = .all
                default: break
                }
            }
            SystemGestures.setDeferredEdges(rect)
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
            (
                filePath: String,
                captureTimeMillis: Int64?,
                displayName: String?
            ) -> [String: Any] in
            let fileURL = URL(fileURLWithPath: filePath)

            guard FileManager.default.fileExists(atPath: filePath) else {
                return ["success": false, "error": "File does not exist"]
            }

            let pathExtension = fileURL.pathExtension.lowercased()
            let isVideo = ["mp4", "mov", "avi", "m4v"].contains(pathExtension)
            let assetFileName = displayName?.isEmpty == false
                ? displayName!
                : fileURL.lastPathComponent
            let captureDate = captureTimeMillis.map {
                Date(timeIntervalSince1970: TimeInterval($0) / 1000.0)
            }
            let candidateFileNames = [assetFileName, fileURL.lastPathComponent]
                .filter { !$0.isEmpty }
            let stableFileName = assetFileName.hasPrefix("IMG_") || assetFileName.hasPrefix("VID_")
                ? assetFileName
                : nil
            let fileAttributes = try? FileManager.default.attributesOfItem(atPath: filePath)
            let expectedFileSize = (fileAttributes?[.size] as? NSNumber)?.int64Value
            let authorizationStatus: PHAuthorizationStatus
            if #available(iOS 14, *) {
                authorizationStatus = PHPhotoLibrary.authorizationStatus(for: .readWrite)
            } else {
                authorizationStatus = PHPhotoLibrary.authorizationStatus()
            }
            let hasLimitedAccess: Bool
            if #available(iOS 14, *) {
                hasLimitedAccess = authorizationStatus == .limited
            } else {
                hasLimitedAccess = false
            }

            // The JS ledger normally supplies the previous PhotoKit receipt. If the app was
            // terminated after Photos committed but before that receipt was persisted, reconcile
            // by our stable capture filename/date before creating another asset.
            if let existingIdentifier = await self.findExistingGalleryAssetIdentifier(
                fileNames: candidateFileNames,
                stableFileName: stableFileName,
                expectedFileSize: expectedFileSize,
                captureDate: captureDate,
                isVideo: isVideo
            ) {
                NSLog("CrustModule: Reusing existing gallery asset")
                return [
                    "success": true,
                    "identifier": existingIdentifier,
                    "existing": true,
                ]
            }

            let saveResult = await self.createGalleryAsset(
                fileURL: fileURL,
                assetFileName: assetFileName,
                captureDate: captureDate,
                isVideo: isVideo,
                hasLimitedAccess: hasLimitedAccess
            )
            if saveResult.timedOut {
                return [
                    "success": false,
                    "error": "Photo library save timed out; retry will reconcile the result",
                ]
            }
            if saveResult.creationFailed {
                return ["success": false, "error": "Failed to create PhotoKit asset placeholder"]
            }
            if let errorMessage = saveResult.errorMessage {
                NSLog("CrustModule: Error saving to gallery: \(errorMessage)")
                return ["success": false, "error": errorMessage]
            }
            guard saveResult.succeeded else {
                return ["success": false, "error": "Photo library did not commit the asset"]
            }

            NSLog("CrustModule: Successfully saved to gallery with proper creation date")
            return ["success": true, "identifier": saveResult.assetIdentifier ?? ""]
        }
    }

    private func createGalleryAsset(
        fileURL: URL,
        assetFileName: String,
        captureDate: Date?,
        isVideo: Bool,
        hasLimitedAccess: Bool
    ) async -> PhotoLibrarySaveResult {
        await withCheckedContinuation { continuation in
            let gate = CheckedContinuationGate(continuation)
            let state = PhotoLibrarySaveState()

            PHPhotoLibrary.shared().performChanges {
                let creationRequest = PHAssetCreationRequest.forAsset()
                let resourceOptions = PHAssetResourceCreationOptions()
                resourceOptions.originalFilename = assetFileName
                creationRequest.addResource(
                    with: isVideo ? .video : .photo,
                    fileURL: fileURL,
                    options: resourceOptions
                )

                if let captureDate {
                    creationRequest.creationDate = captureDate
                    NSLog("CrustModule: Setting creation date to: \(captureDate)")
                }

                guard let assetPlaceholder = creationRequest.placeholderForCreatedAsset else {
                    NSLog("CrustModule: Missing placeholder for created asset")
                    state.markCreationFailed()
                    return
                }
                state.setAssetIdentifier(assetPlaceholder.localIdentifier)

                // Limited-library access permits creating an asset, but does not reliably
                // permit enumerating or mutating arbitrary user albums. Save to the camera
                // roll and skip Mentra album mutation in that mode.
                guard !hasLimitedAccess else { return }

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
            } completionHandler: { succeeded, error in
                let snapshot = state.snapshot()
                gate.resume(returning: PhotoLibrarySaveResult(
                    succeeded: succeeded,
                    assetIdentifier: snapshot.assetIdentifier,
                    creationFailed: snapshot.creationFailed,
                    errorMessage: error?.localizedDescription,
                    timedOut: false
                ))
            }

            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 120) {
                let snapshot = state.snapshot()
                gate.resume(returning: PhotoLibrarySaveResult(
                    succeeded: false,
                    assetIdentifier: snapshot.assetIdentifier,
                    creationFailed: snapshot.creationFailed,
                    errorMessage: nil,
                    timedOut: true
                ))
            }
        }
    }

    private func findExistingGalleryAssetIdentifier(
        fileNames: [String],
        stableFileName: String?,
        expectedFileSize: Int64?,
        captureDate: Date?,
        isVideo: Bool
    ) async -> String? {
        guard !fileNames.isEmpty else { return nil }
        let options = PHFetchOptions()
        let mediaType = isVideo ? PHAssetMediaType.video : PHAssetMediaType.image
        if let captureDate {
            options.predicate = NSPredicate(
                format: "mediaType == %d AND creationDate >= %@ AND creationDate <= %@",
                mediaType.rawValue,
                captureDate.addingTimeInterval(-1) as NSDate,
                captureDate.addingTimeInterval(1) as NSDate
            )
        } else {
            options.predicate = NSPredicate(format: "mediaType == %d", mediaType.rawValue)
            options.fetchLimit = 200
        }
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]

        let assets = PHAsset.fetchAssets(with: options)
        var stableCandidates: [PHAsset] = []
        var legacyCandidates: [PHAsset] = []
        assets.enumerateObjects { asset, _, _ in
            let resources = PHAssetResource.assetResources(for: asset)
            let stableMatch = stableFileName.map { stableName in
                resources.contains { $0.originalFilename == stableName }
            } ?? false
            if stableMatch {
                stableCandidates.append(asset)
                return
            }
            let legacyNameMatch = resources.contains {
                guard fileNames.contains($0.originalFilename), $0.originalFilename != stableFileName else {
                    return false
                }
                return true
            }
            if legacyNameMatch { legacyCandidates.append(asset) }
        }
        guard let expectedFileSize else { return nil }
        // PhotoKit's original-resource lookups are asynchronous. Resolve candidates after
        // enumeration so the fetch callback never blocks the Photos framework. Stable names
        // may repeat across a restored/older library; require the generation's exact byte size
        // and reuse the newest matching completed asset.
        for asset in stableCandidates {
            if await self.assetOriginalFile(asset, matchesByteCount: expectedFileSize) {
                return asset.localIdentifier
            }
        }

        var legacyIdentifiers: [String] = []
        for asset in legacyCandidates {
            if await self.assetOriginalFile(asset, matchesByteCount: expectedFileSize) {
                legacyIdentifiers.append(asset.localIdentifier)
            }
        }
        // Legacy base names remain safe only when name + capture time + media type + exact
        // original byte size identify one asset.
        return legacyIdentifiers.count == 1 ? legacyIdentifiers[0] : nil
    }

    /// PhotoKit does not expose resource byte size on the deployment targets we support.
    /// Inspect a video's local original URL or an image's original bytes asynchronously.
    /// Network access stays disabled: if the original is only in iCloud, reconciliation fails
    /// closed and the caller creates a fresh local-library asset instead of risking data loss.
    private func assetOriginalFile(
        _ asset: PHAsset,
        matchesByteCount expectedByteCount: Int64
    ) async -> Bool {
        let manager = PHImageManager.default()
        if asset.mediaType == .video {
            let options = PHVideoRequestOptions()
            options.isNetworkAccessAllowed = false
            options.version = .original
            return await withCheckedContinuation { continuation in
                let gate = CheckedContinuationGate(continuation)
                let requestID = manager.requestAVAsset(forVideo: asset, options: options) { avAsset, _, _ in
                    guard let originalURL = (avAsset as? AVURLAsset)?.url,
                          let attributes = try? FileManager.default.attributesOfItem(atPath: originalURL.path),
                          let byteCount = attributes[.size] as? NSNumber else {
                        gate.resume(returning: false)
                        return
                    }
                    gate.resume(returning: byteCount.int64Value == expectedByteCount)
                }
                DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 30) {
                    manager.cancelImageRequest(requestID)
                    gate.resume(returning: false)
                }
            }
        }

        let options = PHImageRequestOptions()
        options.isNetworkAccessAllowed = false
        options.version = .original
        options.deliveryMode = .highQualityFormat
        return await withCheckedContinuation { continuation in
            let gate = CheckedContinuationGate(continuation)
            let requestID = manager.requestImageDataAndOrientation(for: asset, options: options) { data, _, _, info in
                if info?[PHImageResultIsDegradedKey] as? Bool == true { return }
                gate.resume(returning: data.map { Int64($0.count) == expectedByteCount } ?? false)
            }
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 30) {
                manager.cancelImageRequest(requestID)
                gate.resume(returning: false)
            }
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
