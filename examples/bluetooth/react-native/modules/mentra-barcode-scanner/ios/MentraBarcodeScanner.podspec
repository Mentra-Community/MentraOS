Pod::Spec.new do |s|
  s.name           = 'MentraBarcodeScanner'
  s.version        = '0.1.0'
  s.summary        = 'Mentra local barcode scanner'
  s.description    = 'Small native barcode scanner used by Mentra Bluetooth SDK React Native examples to scan received photo previews.'
  s.author         = 'Mentra'
  s.license        = { :type => 'MIT' }
  s.homepage       = 'https://mentra.glass'
  s.platforms      = {
    :ios => '15.1'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = ['CoreImage', 'Vision', 'UIKit']

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
