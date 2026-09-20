require 'json'
package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))
Pod::Spec.new do |s|
  s.name = 'FramePreview'
  s.version = package['version']
  s.summary = package['description']
  s.homepage = package['homepage']
  s.license = package['license']
  s.author = package['author']
  s.source = { git: 'https://github.com/Mentra-Community/MentraOS.git' }
  s.platforms = { :ios => '15.1' }
  s.swift_version = '5.9'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  # DecodedFrameTap lives beside the existing decoders rather than here, so the preview can
  # attach without the media pod knowing anything about WebViews.
  s.dependency 'GlassesMedia'
  s.frameworks = 'CoreVideo', 'CoreMedia', 'Network'
  # PreviewKit is a Swift package so its pure logic can be unit tested with `swift test`, and its
  # sources are compiled straight into this pod the way GlassesMedia does with CoreKit.
  s.source_files = '*.{swift,h,m,mm}', 'PreviewKit/Sources/FramePreviewCore/*.swift'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
