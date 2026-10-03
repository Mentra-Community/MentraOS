require 'tmpdir'
require_relative 'configure-example-ios-signing'

Dir.mktmpdir('mentra-signing-') do |directory|
  project_path = File.join(directory, 'Example.xcodeproj')
  project = Xcodeproj::Project.new(project_path)
  app = project.new_target(:application, 'Example', :ios, '15.5')
  framework = project.new_target(:framework, 'AzureCommunicationCommon', :ios, '15.5')
  app.build_configurations.each { |config| config.build_settings['PRODUCT_BUNDLE_IDENTIFIER'] = 'com.mentra.example' }
  project.save
  framework_settings = framework.build_configurations.map { |config| config.build_settings.dup }
  debug_settings = app.build_configurations.find { |config| config.name == 'Debug' }.build_settings.dup

  2.times { configure_example_ios_signing(project_path, 'com.mentra.example', 'TEAM', 'Apple Distribution', 'AppStore Profile') }
  project = Xcodeproj::Project.open(project_path)
  app = project.targets.find { |target| target.name == 'Example' }
  release = app.build_configurations.find { |config| config.name == 'Release' }.build_settings
  raise 'Missing app profile' unless release['PROVISIONING_PROFILE_SPECIFIER'] == 'AppStore Profile'
  raise 'Missing manual signing' unless release['CODE_SIGN_STYLE'] == 'Manual'
  raise 'Missing distribution identity' unless release['CODE_SIGN_IDENTITY[sdk=iphoneos*]'] == 'Apple Distribution'
  raise 'Modified Debug signing' unless app.build_configurations.find { |config| config.name == 'Debug' }.build_settings == debug_settings
  raise 'Modified framework settings' unless project.targets.find { |target| target.name == 'AzureCommunicationCommon' }.build_configurations.map(&:build_settings) == framework_settings
  before = File.read(File.join(project_path, 'project.pbxproj'))
  begin
    configure_example_ios_signing(project_path, 'wrong.bundle', 'TEAM', 'identity', 'profile')
    raise 'Accepted wrong bundle ID'
  rescue RuntimeError => error
    raise unless error.message.include?('Expected one Release app configuration')
  end
  raise 'Mutated project on failure' unless File.read(File.join(project_path, 'project.pbxproj')) == before
end
puts 'Signing fixture passed: app-only Release settings, idempotency, and wrong-bundle rejection.'
