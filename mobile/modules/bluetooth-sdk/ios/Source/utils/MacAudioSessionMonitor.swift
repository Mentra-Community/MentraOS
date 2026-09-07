#if os(macOS)
    import Foundation

    enum AudioSessionMonitor {
        static func isAudioDeviceConnected(devicePattern: String) -> Bool {
            MacAudioDevice.available.contains {
                $0.isBluetooth && $0.name.localizedCaseInsensitiveContains(devicePattern)
            }
        }

        static func isOtherAudioDeviceConnected(devicePattern: String) -> Bool {
            let output = MacAudioDevice.defaultOutput
            return MacAudioDevice.available.contains {
                $0.id == output && $0.isBluetooth && !$0.name.localizedCaseInsensitiveContains(devicePattern)
            }
        }
    }
#endif
