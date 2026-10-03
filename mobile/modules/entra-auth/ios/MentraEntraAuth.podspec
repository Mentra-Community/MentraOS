require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'MentraEntraAuth'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = package['license']
  s.author         = 'Mentra'
  s.homepage       = 'https://mentra.glass'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/Mentra-Community/MentraOS.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # 2.11.0 is the newest MSAL release compatible with the Mentra App's iOS
  # 15.1 deployment target. MSAL 2.12+ requires iOS 16 and 2.15 requires 17.
  s.dependency 'MSAL', '2.11.0'
  s.source_files = '**/*.{h,m,mm,swift}'
end
