Pod::Spec.new do |s|
  s.name           = 'MentraPhotoReceiver'
  s.version        = '0.1.0'
  s.summary        = 'Mentra local photo upload receiver'
  s.description    = 'Small local HTTP upload receiver used by Mentra Bluetooth SDK React Native apps for direct photo capture to the phone.'
  s.author         = 'Mentra'
  s.license        = { :type => 'MIT' }
  s.homepage       = 'https://mentra.glass'
  s.platforms      = {
    :ios => '15.1'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'Network'
  s.source_files = "**/*.{swift}"
end
