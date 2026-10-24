require 'tmpdir'
require 'fileutils'

react_native_path = ARGV.fetch(0, File.expand_path('../node_modules/react-native', __dir__))
require File.join(react_native_path, 'sdks/hermes-engine/hermes-utils.rb')

# Exercise the installed RN selector without network or a CocoaPods install.
def release_artifact_exists(_version)
  $release_exists
end

def nightly_artifact_exists(_version)
  $nightly_exists
end

overrides = %w[REACT_NATIVE_OVERRIDE_HERMES_DIR HERMES_ENGINE_TARBALL_PATH HERMES_COMMIT RCT_BUILD_HERMES_FROM_SOURCE RCT_HERMES_V1_ENABLED]
original_env = overrides.to_h { |key| [key, ENV[key]] }
checks = 0
check = lambda do |actual, expected|
  raise "Expected #{expected.inspect}, got #{actual.inspect}" unless actual == expected
  checks += 1
end

begin
  overrides.each { |key| ENV.delete(key) }
  Dir.mktmpdir('mentra-hermes-selector-') do |rn|
    FileUtils.mkdir_p(File.join(rn, 'sdks'))
    File.write(File.join(rn, 'sdks/.hermesversion'), "hermes-v0.14.1\n")
    File.write(File.join(rn, 'sdks/.hermesv1version'), "hermes-v250829098.0.4\n")

    $release_exists = $nightly_exists = false
    selected = hermes_source_type('0.14.1', rn)
    check.call(selected, HermesEngineSourceType::BUILD_FROM_GITHUB_TAG)
    check.call(podspec_source(selected, '0.14.1', rn), {git: HERMES_GITHUB_URL, tag: 'hermes-v0.14.1'})

    $release_exists = true
    check.call(hermes_source_type('0.14.1', rn), HermesEngineSourceType::DOWNLOAD_PREBUILD_RELEASE_TARBALL)
    $release_exists = false
    $nightly_exists = true
    check.call(hermes_source_type('0.14.1', rn), HermesEngineSourceType::DOWNLOAD_PREBUILT_NIGHTLY_TARBALL)

    ENV['HERMES_COMMIT'] = 'explicit-development-commit'
    check.call(hermes_source_type('0.14.1', rn), HermesEngineSourceType::BUILD_FROM_GITHUB_COMMIT)
    ENV.delete('HERMES_COMMIT')

    $nightly_exists = false
    ENV['RCT_HERMES_V1_ENABLED'] = '1'
    selected = hermes_source_type('250829098.0.4', rn)
    check.call(selected, HermesEngineSourceType::BUILD_FROM_GITHUB_TAG)
    check.call(podspec_source(selected, '250829098.0.4', rn), {git: HERMES_GITHUB_URL, tag: 'hermes-v250829098.0.4'})

    FileUtils.rm(File.join(rn, 'sdks/.hermesv1version'))
    begin
      podspec_source(hermes_source_type('250829098.0.4', rn), '250829098.0.4', rn)
      raise 'Missing RN version file must refuse source selection'
    rescue Errno::ENOENT
      checks += 1
    end
  end
ensure
  original_env.each { |key, value| value.nil? ? ENV.delete(key) : ENV[key] = value }
end

puts "#{checks} Hermes source-selection checks passed"
