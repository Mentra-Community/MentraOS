#if os(macOS)
    import Foundation

    enum AudioSessionMonitor {
        private static var observer: MacAudioRouteObserver?

        static func isAudioSessionConfigured() -> Bool {
            true
        }

        static func isAudioDeviceConnected(devicePattern: String) -> Bool {
            MacAudioDevice.available.contains {
                $0.id == MacAudioDevice.defaultOutput && $0.isBluetooth && $0.name.localizedCaseInsensitiveContains(devicePattern)
            }
        }

        static func isOtherAudioDeviceConnected(devicePattern: String) -> Bool {
            MacAudioDevice.available.contains {
                $0.id == MacAudioDevice.defaultOutput && $0.isBluetooth && !$0.name.localizedCaseInsensitiveContains(devicePattern)
            }
        }

        static func isDevicePaired(devicePattern: String) -> Bool {
            MacAudioDevice.available.contains { $0.isBluetooth && $0.name.localizedCaseInsensitiveContains(devicePattern) }
        }

        static func startMonitoring(devicePattern: String, callback: @escaping (Bool, String?) -> Void) {
            observer = MacAudioRouteObserver {
                let device = MacAudioDevice.available.first { $0.isBluetooth && $0.name.localizedCaseInsensitiveContains(devicePattern) }
                callback(device != nil, device?.name)
            }
        }

        static func stopMonitoring() {
            observer = nil
        }
    }
#endif
