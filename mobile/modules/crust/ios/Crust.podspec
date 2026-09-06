require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'Crust'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = package['license']
  s.author         = package['author']
  s.homepage       = package['homepage']
  s.platforms      = {
    :ios => '15.1',
    :tvos => '15.1'
  }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/fossephate/crust' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # Mapbox Navigation SDK v3 for iOS (migrated from GoogleNavigation, matching
  # the Android Mapbox migration). It is added as a SWIFT PACKAGE, not a
  # CocoaPods dependency — Mapbox Nav v3 dropped reliable CocoaPods support, so
  # `pod install` cannot resolve 'MapboxNavigationCore' ("Unable to find a
  # specification"). The SPM package is wired into the Xcode project by
  # @mentra/crust/plugin/src/withMapboxNavIos.ts at prebuild, and its MapboxMaps dependency
  # + Downloads-token auth come from the @rnmapbox/maps config plugin. So there
  # is intentionally NO `s.dependency 'MapboxNavigationCore'` here.

  # iOS frameworks required for media processing + navigation + heading
  s.frameworks = 'AVFoundation', 'Photos', 'CoreImage', 'CoreGraphics', 'UIKit', 'CoreLocation', 'CoreMotion'

  # Swift/Objective-C compatibility + Mapbox SPM module visibility.
  #
  # MapboxNavigationCore / MapboxMaps / MapboxDirections are linked into the
  # Crust target as Swift Package products (see plugin/src/withMapboxNavCrustLink.ts).
  # MapboxDirections builds as a STATIC LIBRARY, so SPM emits it as a bare
  # `MapboxDirections.swiftmodule` in the build-products dir rather than a
  # `.framework`. For `import MapboxDirections` to resolve from this CocoaPods
  # target, its build-products dir must be on SWIFT_INCLUDE_PATHS (and the
  # framework dir on FRAMEWORK_SEARCH_PATHS for the .framework deps like
  # MapboxMaps/MapboxCommon/MapboxCoreMaps). ${PODS_CONFIGURATION_BUILD_DIR}
  # resolves to Build/Products/$CONFIGURATION-$PLATFORM, where SPM drops them.
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_INCLUDE_PATHS' => '$(inherited) "${PODS_CONFIGURATION_BUILD_DIR}"',
    'FRAMEWORK_SEARCH_PATHS' => '$(inherited) "${PODS_CONFIGURATION_BUILD_DIR}"',
    'OTHER_SWIFT_FLAGS' => '$(inherited) -I "${PODS_CONFIGURATION_BUILD_DIR}"',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"

  # Ship the MentraJS polyfill bundle inside the pod's resource bundle so
  # JSCRuntime can read it at runtime via Bundle.main. The source of
  # truth lives at `@mentra/jspolyfill/assets/startup.js`, but
  # CocoaPods silently drops `..` paths from `resource_bundles` — so the
  # runtime's build script mirrors the file to `ios/Resources/startup.js`
  # (gitignored) and we point the glob at that local path. Run
  # `bun run --filter @mentra/jspolyfill build` (or just `bun install`
  # at the repo root) to regenerate it after editing the polyfill source.
  s.resource_bundles = {
    'MentraJSRuntime' => ['Resources/startup.js']
  }
end
