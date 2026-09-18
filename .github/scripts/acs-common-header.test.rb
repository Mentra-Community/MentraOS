require 'fileutils'
require 'json'
require 'minitest/autorun'
require 'open3'
require 'tmpdir'

class AcsCommonHeaderTest < Minitest::Test
  PODSPEC = File.expand_path('../../mobile/modules/acs-meeting/ios/AcsMeeting.podspec', __dir__)
  spec, status = Open3.capture2e('pod', 'ipc', 'spec', PODSPEC)
  raise spec unless status.success?
  SCRIPT = JSON.parse(spec).fetch('script_phases').first.fetch('script')

  def with_layout(kind)
    Dir.mktmpdir('acs-common-header') do |dir|
      env = {
        'PODS_ROOT' => "#{dir}/Pods",
        'PODS_CONFIGURATION_BUILD_DIR' => "#{dir}/products",
        'PODS_XCFRAMEWORKS_BUILD_DIR' => "#{dir}/xcframeworks",
      }
      paths = {
        vendored: "#{env['PODS_XCFRAMEWORKS_BUILD_DIR']}/AzureCommunicationCommon/AzureCommunicationCommon.framework/Headers/AzureCommunicationCommon-Swift.h",
        framework: "#{env['PODS_CONFIGURATION_BUILD_DIR']}/AzureCommunicationCommon/AzureCommunicationCommon.framework/Headers/AzureCommunicationCommon-Swift.h",
        static: "#{env['PODS_CONFIGURATION_BUILD_DIR']}/AzureCommunicationCommon/Swift Compatibility Header/AzureCommunicationCommon-Swift.h",
      }
      source = paths.fetch(kind)
      public_header = "#{env['PODS_ROOT']}/Headers/Public/AzureCommunicationCommon/AzureCommunicationCommon-Swift.h"
      FileUtils.mkdir_p(File.dirname(source))
      File.write(source, 'current SDK header')
      FileUtils.mkdir_p(File.dirname(public_header))
      File.write(public_header, 'stale loose header from an earlier build')
      output, status = Open3.capture2e(env, '/bin/sh', '-c', SCRIPT)
      assert status.success?, output
      yield source, public_header, env
    end
  end

  def test_source_framework_removes_the_loose_header_that_shadows_swift_types
    with_layout(:framework) do |source, public_header, _|
      assert File.file?(source)
      refute File.exist?(public_header)
    end
  end

  def test_vendored_framework_also_removes_the_loose_header
    with_layout(:vendored) do |source, public_header, _|
      assert File.file?(source)
      refute File.exist?(public_header)
    end
  end

  def test_static_library_retains_its_header_compatibility_path
    with_layout(:static) do |source, public_header, env|
      assert_equal File.read(source), File.read(public_header)
      fallback = "#{env['PODS_CONFIGURATION_BUILD_DIR']}/AcsMeeting/AzureCommunicationCommon.framework/Headers/AzureCommunicationCommon-Swift.h"
      assert_equal File.read(source), File.read(fallback)
      refute File.exist?("#{env['PODS_CONFIGURATION_BUILD_DIR']}/AzureCommunicationCommon.framework")
    end
  end
end
