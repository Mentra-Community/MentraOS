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
  # JSCRuntime can read it at runtime via Bundle.main. We pull from the
  # sibling @mentra/mentrajs-runtime module's `assets/` directory — that's
  # the single committed source of truth (rebuilt by `bun run build` in
  # that module whenever startup.ts changes). Globbing across module
  # boundaries here avoids checking the same file into git three times.
  s.resource_bundles = {
    'MentraJSRuntime' => ['../../mentrajs-runtime/assets/startup.js']
  }
end
