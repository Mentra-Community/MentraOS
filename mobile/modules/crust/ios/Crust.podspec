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
  s.dependency 'GoogleNavigation'

  # iOS frameworks required for media processing + navigation + heading
  s.frameworks = 'AVFoundation', 'Photos', 'CoreImage', 'CoreGraphics', 'UIKit', 'CoreLocation', 'CoreMotion'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'FRAMEWORK_SEARCH_PATHS' => '$(inherited) $(PODS_ROOT)/GoogleNavigation/Frameworks $(PODS_ROOT)/GoogleMaps/Maps/Frameworks',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"

  # Ship the MentraJS polyfill bundle inside the pod's resource bundle so
  # JSCRuntime can read it at runtime via Bundle.main. The source of
  # truth lives at `@mentra/mentrajs-runtime/assets/startup.js`, but
  # CocoaPods silently drops `..` paths from `resource_bundles` — so the
  # runtime's build script mirrors the file to `ios/Resources/startup.js`
  # (gitignored) and we point the glob at that local path. Run
  # `bun run --filter @mentra/mentrajs-runtime build` (or just `bun install`
  # at the repo root) to regenerate it after editing the polyfill source.
  s.resource_bundles = {
    'MentraJSRuntime' => ['Resources/startup.js']
  }
end
