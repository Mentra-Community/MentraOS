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
  }
  s.source_files = '*.{h,m,mm,swift}', 'PolicyKit/Sources/AcsAudioPolicy/*.swift'
end
