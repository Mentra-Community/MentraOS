require 'xcodeproj'

# Provisioning profiles belong to the application, never dependency frameworks.
def configure_example_ios_signing(project_path, bundle_id, team, identity, profile)
  project = Xcodeproj::Project.open(project_path)
  configs = project.targets.select { |target| target.product_type == 'com.apple.product-type.application' }
    .flat_map(&:build_configurations)
    .select { |config| config.name == 'Release' && config.build_settings['PRODUCT_BUNDLE_IDENTIFIER'] == bundle_id }
  raise "Expected one Release app configuration for #{bundle_id}, found #{configs.length}" unless configs.length == 1

  settings = configs.first.build_settings
  settings['DEVELOPMENT_TEAM'] = team
  settings['CODE_SIGN_STYLE'] = 'Manual'
  settings['CODE_SIGN_IDENTITY'] = identity
  settings['CODE_SIGN_IDENTITY[sdk=iphoneos*]'] = identity
  settings['PROVISIONING_PROFILE_SPECIFIER'] = profile
  project.save
end

if $PROGRAM_NAME == __FILE__
  configure_example_ios_signing(
    ARGV.fetch(0), ENV.fetch('EXAMPLE_BUNDLE_ID'), ENV.fetch('APPLE_TEAM_ID'),
    ENV.fetch('MENTRA_CI_CODE_SIGN_IDENTITY'), ENV.fetch('MENTRA_CI_PROVISIONING_PROFILE_NAME')
  )
end
