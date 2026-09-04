#if os(macOS)
    import CoreAudio
    import Foundation

    struct MacAudioDevice {
        let id: AudioDeviceID
        let name: String
        let transport: UInt32
        let hasInput: Bool

        var isBluetooth: Bool {
            transport == kAudioDeviceTransportTypeBluetooth || transport == kAudioDeviceTransportTypeBluetoothLE
        }

        static var available: [MacAudioDevice] {
            var address = address(kAudioHardwarePropertyDevices)
            var size: UInt32 = 0
            guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr
            else { return [] }
            var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
            guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids) == noErr
            else { return [] }
            return ids.compactMap { id in
                var nameAddress = self.address(kAudioObjectPropertyName)
                var name: Unmanaged<CFString>?
                var nameSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
                guard AudioObjectGetPropertyData(id, &nameAddress, 0, nil, &nameSize, &name) == noErr
                else { return nil }
                guard let name = name?.takeRetainedValue() else { return nil }
                var inputAddress = self.address(kAudioDevicePropertyStreams, scope: kAudioObjectPropertyScopeInput)
                var inputSize: UInt32 = 0
                let hasInput = AudioObjectGetPropertyDataSize(id, &inputAddress, 0, nil, &inputSize) == noErr && inputSize > 0
                return MacAudioDevice(id: id, name: name as String,
                                      transport: value(id, kAudioDevicePropertyTransportType) ?? 0, hasInput: hasInput)
            }
        }

        static var defaultInput: AudioDeviceID? {
            value(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultInputDevice)
        }

        static var defaultOutput: AudioDeviceID? {
            value(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultOutputDevice)
        }

        static func value(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> UInt32? {
            var address = address(selector)
            var value: UInt32 = 0
            var size = UInt32(MemoryLayout<UInt32>.size)
            return AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr ? value : nil
        }

        static func address(_ selector: AudioObjectPropertySelector,
                            scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress
        {
            AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
        }
    }

    /// Observe route changes without selecting a system-wide audio device.
    final class MacAudioRouteObserver {
        private let listener: AudioObjectPropertyListenerBlock
        private var selectors: [AudioObjectPropertySelector] = []

        init(onChange: @escaping () -> Void) {
            listener = { _, _ in onChange() }
            for selector in [kAudioHardwarePropertyDevices, kAudioHardwarePropertyDefaultInputDevice,
                             kAudioHardwarePropertyDefaultOutputDevice]
            {
                var address = MacAudioDevice.address(selector)
                if AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &address, .main, listener) == noErr {
                    selectors.append(selector)
                }
            }
        }

        deinit {
            for selector in selectors {
                var address = MacAudioDevice.address(selector)
                AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &address, .main, listener)
            }
        }
    }
#endif
