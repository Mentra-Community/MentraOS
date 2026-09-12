require 'json'
package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))
Pod::Spec.new do |s|
  s.name = 'GlassesMedia'
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
  s.dependency 'WebRTC-SDK', '137.7151.09'
  s.frameworks = 'AVFoundation', 'CoreMedia', 'CoreVideo', 'Network', 'NetworkExtension'
  s.source_files = '*.{swift,h,m,mm}', 'CoreKit/Sources/GlassesMediaCore/*.swift'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
