require 'cocoapods'
require 'tmpdir'

podfile = Pod::Podfile.from_file(Pathname(ARGV.fetch(0)))
Pod::Config.instance.silent = true

Dir.mktmpdir('mentra-pods-objects-') do |directory|
  # Exercise every remaining-pool size, including exhaustion while creating
  # the Mapbox host's sources/frameworks phases after target UUID stabilization.
  (0..100).each do |padding|
    project = Pod::Project.new(File.join(directory, 'Pods.xcodeproj'))
    crust = project.new_target(:static_library, 'Crust', :ios, '15.1')
    padding.times { |index| project.main_group.new_file("file#{index}.swift") }
    Pod::Installer::TargetUUIDGenerator.new([project]).generate!
    original = project.objects_by_uuid.dup
    installer = Struct.new(:pods_project).new(project)

    2.times do
      podfile.post_install!(installer)
      original.each do |uuid, object|
        actual = project.objects_by_uuid[uuid]
        raise "padding=#{padding}: #{object.isa} #{uuid} replaced by #{actual&.isa}" unless actual.equal?(object)
      end
      hosts = project.targets.select { |target| target.name == 'MapboxNavOrder' }
      raise 'Expected one Mapbox host' unless hosts.size == 1
      raise 'Missing Crust build-order dependency' unless crust.dependencies.count { |dep| dep.target == hosts.first } == 1
      raise 'Mapbox must not be linked into Crust' unless crust.package_product_dependencies.empty?
      expected = %w[MapboxDirections MapboxMaps MapboxNavigationCore]
      raise 'Missing host package products' unless hosts.first.package_product_dependencies.map(&:product_name).sort == expected

      # Validate the actual serialized graph, including rootObject's type.
      reopened = Xcodeproj::Project.open(project.path)
      raise 'Invalid serialized rootObject' unless reopened.root_object.isa == 'PBXProject'
      raise 'Missing serialized Crust target' unless reopened.targets.any? { |target| target.name == 'Crust' }
    end
  end
end
puts '101 UUID pool positions passed, including repeated hook application and project reload.'
