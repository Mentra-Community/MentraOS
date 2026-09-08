require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'AcsMeeting'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = package['license']
  s.author         = package['author']
  s.homepage       = package['homepage']
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/Mentra-Community/MentraOS.git' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.dependency 'AzureCommunicationCalling', '~> 2.15'
  s.dependency 'AzureCommunicationCommon', '~> 1.1'
  # Pin to the same WebRTC-SDK the Mentra App already links via LiveKit.
  s.dependency 'WebRTC-SDK', '137.7151.09'
  s.frameworks = 'AVFoundation', 'AudioToolbox', 'CoreMedia', 'CoreVideo', 'UIKit'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    # Calling's umbrella does #import <AzureCommunicationCommon/AzureCommunicationCommon-Swift.h>.
    # Vendored Common headers must resolve inside their framework module.
    # Source-built pods retain the public-header compatibility fallback, and
    # only the static-lib fallback needs a header-only framework.
    'FRAMEWORK_SEARCH_PATHS' => '$(inherited) "${PODS_XCFRAMEWORKS_BUILD_DIR}/AzureCommunicationCommon" "${PODS_CONFIGURATION_BUILD_DIR}/AzureCommunicationCommon" "${PODS_CONFIGURATION_BUILD_DIR}/AcsMeeting"',
    'HEADER_SEARCH_PATHS' => '$(inherited) "${PODS_CONFIGURATION_BUILD_DIR}" "${PODS_CONFIGURATION_BUILD_DIR}/AzureCommunicationCommon"',
  }
  s.script_phases = [
    {
      :name => 'Expose AzureCommunicationCommon Swift header',
      :execution_position => :before_compile,
      :script => %(
        set -e
        # CocoaPods stages the slice for the current platform/architecture here.
        # Do not pick a device or simulator slice directly from the pod sources.
        XC_HDR="${PODS_XCFRAMEWORKS_BUILD_DIR}/AzureCommunicationCommon/AzureCommunicationCommon.framework/Headers/AzureCommunicationCommon-Swift.h"
        FW_HDR="${PODS_CONFIGURATION_BUILD_DIR}/AzureCommunicationCommon/AzureCommunicationCommon.framework/Headers/AzureCommunicationCommon-Swift.h"
        STATIC_HDR="${PODS_CONFIGURATION_BUILD_DIR}/AzureCommunicationCommon/Swift Compatibility Header/AzureCommunicationCommon-Swift.h"
        if [ -f "$XC_HDR" ]; then
          SRC="$XC_HDR"
        elif [ -f "$FW_HDR" ]; then
          SRC="$FW_HDR"
        elif [ -f "$STATIC_HDR" ]; then
          SRC="$STATIC_HDR"
        else
          echo "error: AzureCommunicationCommon-Swift.h missing (Common must build first)"
          echo "looked for: $XC_HDR"
          echo "looked for: $FW_HDR"
          echo "looked for: $STATIC_HDR"
          exit 1
        fi
        # This phase runs on every build, so only write when the bytes actually
        # differ. An unconditional cp refreshes the mtime of a public header and
        # makes Xcode recompile every dependent target for no reason.
        copy_if_changed() {
          if [ ! -f "$2" ] || ! cmp -s "$1" "$2"; then
            mkdir -p "$(dirname "$2")"
            cp -f "$1" "$2"
          fi
        }
        # Never write a fake AzureCommunicationCommon.framework into BUILT_PRODUCTS_DIR.
        # CocoaPods' embed script prefers ${BUILT_PRODUCTS_DIR}/$(basename) and would
        # then codesign an empty header-only bundle ("bundle format unrecognized").
        rm -rf "${PODS_CONFIGURATION_BUILD_DIR}/AzureCommunicationCommon.framework"
        PUBLIC_HDR="${PODS_ROOT}/Headers/Public/AzureCommunicationCommon/AzureCommunicationCommon-Swift.h"
        if [ -f "$XC_HDR" ]; then
          # A loose copy shadows the vendored framework's modular header. Clang
          # then imports its credential into Calling as a second Swift type,
          # incompatible with Common.CommunicationTokenCredential. Remove copies
          # left by earlier builds and let the framework search path resolve it.
          rm -f "$PUBLIC_HDR"
        else
          copy_if_changed "$SRC" "$PUBLIC_HDR"
        fi
        if [ ! -f "$XC_HDR" ] && [ ! -f "$FW_HDR" ]; then
          FAKE_HEADERS="${PODS_CONFIGURATION_BUILD_DIR}/AcsMeeting/AzureCommunicationCommon.framework/Headers"
          copy_if_changed "$SRC" "$FAKE_HEADERS/AzureCommunicationCommon-Swift.h"
        fi
      ),
    },
  ]
  s.source_files = '*.{h,m,mm,swift}', 'PolicyKit/Sources/AcsAudioPolicy/*.swift'
end
