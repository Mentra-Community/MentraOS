# Scope provisioning to the application, never Pods or framework targets.
require 'json'
require 'xcodeproj'

settings = JSON.parse(File.read(ARGV.fetch(1)))
project = Xcodeproj::Project.open(ARGV.fetch(0))
apps = project.targets.select { |target| target.product_type == 'com.apple.product-type.application' }
abort 'Expected exactly one application target' unless apps.length == 1
release = apps.first.build_configurations.find { |config| config.name == 'Release' }
abort 'Missing application Release configuration' unless release
release.build_settings.merge!({
  'CODE_SIGN_STYLE' => 'Manual',
  'CODE_SIGN_IDENTITY' => settings.fetch('certificate'),
  'CODE_SIGN_IDENTITY[sdk=iphoneos*]' => settings.fetch('certificate'),
  'DEVELOPMENT_TEAM' => settings.fetch('team'),
  'PROVISIONING_PROFILE_SPECIFIER' => settings.fetch('profile'),
})
project.save
