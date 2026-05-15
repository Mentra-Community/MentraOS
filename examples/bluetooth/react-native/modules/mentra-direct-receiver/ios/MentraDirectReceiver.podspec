Pod::Spec.new do |s|
  s.name           = 'MentraDirectReceiver'
  s.version        = '1.0.0'
  s.summary        = 'Mentra direct phone media receiver'
  s.description    = 'Local native receiver used by the Mentra Bluetooth SDK React Native example.'
  s.author         = 'Mentra'
  s.license        = { :type => 'MIT' }
  s.homepage       = 'https://mentra.glass'
  s.platforms      = {
    :ios => '15.1'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  gstreamer_root = ENV['GSTREAMER_ROOT_IOS'] || File.expand_path('~/Library/Developer/GStreamer/iPhone.sdk')
  s.public_header_files = 'GStreamerWhipReceiver.h'
  s.private_header_files = 'gst_ios_init.h'
  s.frameworks = [
    'GStreamer',
    'CoreFoundation',
    'Foundation',
    'AVFoundation',
    'CoreMedia',
    'CoreVideo',
    'CoreAudio',
    'AudioToolbox',
    'AssetsLibrary',
    'OpenGLES',
    'QuartzCore',
    'UIKit'
  ]
  s.weak_frameworks = 'VideoToolbox'
  s.libraries = 'resolv', 'iconv', 'c++'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'CLANG_ALLOW_NON_MODULAR_INCLUDES_IN_FRAMEWORK_MODULES' => 'YES',
    'FRAMEWORK_SEARCH_PATHS' => '"$(inherited)" "' + gstreamer_root + '"',
    'HEADER_SEARCH_PATHS' => '"$(inherited)" "' + gstreamer_root + '/GStreamer.framework/Headers"',
    'OTHER_LDFLAGS' => '$(inherited) -Wl,-no_compact_unwind',
  }
  s.user_target_xcconfig = {
    'FRAMEWORK_SEARCH_PATHS' => '"$(inherited)" "' + gstreamer_root + '"',
    'OTHER_LDFLAGS' => '$(inherited) -Wl,-no_compact_unwind',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
