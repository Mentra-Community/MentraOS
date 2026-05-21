Pod::Spec.new do |s|
  s.name           = 'MentraVideoStreamReceiver'
  s.version        = '0.1.0'
  s.summary        = 'Mentra local video stream receiver'
  s.description    = 'Local WebRTC/GStreamer receiver used by Mentra Bluetooth SDK React Native apps for direct camera streaming to the phone.'
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
  gstreamer_framework = File.join(gstreamer_root, 'GStreamer.framework')
  setup_gstreamer_script = File.expand_path('../scripts/setup-gstreamer-ios.sh', __dir__)

  if !Dir.exist?(gstreamer_framework) && ENV['GSTREAMER_ROOT_IOS'].nil?
    puts "MentraVideoStreamReceiver: GStreamer iOS SDK not found at #{gstreamer_root}."
    puts 'MentraVideoStreamReceiver: downloading it now; set GSTREAMER_VERSION to override the version.'
    unless system('bash', setup_gstreamer_script)
      raise 'Failed to install the GStreamer iOS SDK. Run modules/mentra-video-stream-receiver/scripts/setup-gstreamer-ios.sh and retry.'
    end
  end

  unless Dir.exist?(gstreamer_framework)
    raise "GStreamer.framework not found at #{gstreamer_framework}. Set GSTREAMER_ROOT_IOS to the installed iPhone.sdk path or run modules/mentra-video-stream-receiver/scripts/setup-gstreamer-ios.sh."
  end

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
    'Network',
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
