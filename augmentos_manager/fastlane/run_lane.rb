#!/usr/bin/env ruby

# Define the lane directly in this file instead of trying to load the Fastfile
module Fastlane
  module Android
    def self.bump_version_and_build
      # Get the absolute path of the project
      project_dir = File.expand_path('../../', __FILE__)
      gradle_file_path = File.join(project_dir, 'android', 'app', 'build.gradle')
      
      puts "Looking for gradle file at: #{gradle_file_path}"
      
      # Read current version code
      s = File.read(gradle_file_path)
      current_version_code = s[/versionCode\s+(\d+)/, 1].to_i
      
      # Increment version code
      new_version_code = current_version_code + 1
      new_contents = s.sub(/versionCode\s+#{current_version_code}/, "versionCode #{new_version_code}")
      
      # Write updated version code
      File.write(gradle_file_path, new_contents)
      
      puts "✅ Version code bumped from #{current_version_code} to #{new_version_code}"
      
      # Build the app bundle
      android_dir = File.join(project_dir, 'android')
      Dir.chdir(android_dir) do
        puts "Building in directory: #{Dir.pwd}"
        system("./gradlew clean bundleRelease")
        exit_code = $?.exitstatus
        if exit_code != 0
          puts "❌ Build failed with exit code #{exit_code}"
          exit(exit_code)
        end
      end
      
      # Show the full path to the AAB file
      aab_path = File.join(android_dir, 'app', 'build', 'outputs', 'bundle', 'release', 'app-release.aab')
      puts "✅ App bundle built successfully!"
      puts "📱 Find the AAB at: #{aab_path}"
    end
  end
  
  class LaneManager
    def self.cruise_lane(platform, lane_name)
      # Load the lane
      begin
        platform_obj = Fastlane.const_get(platform.to_s.capitalize)
        platform_obj.send(lane_name)
      rescue => e
        puts "Error running lane: #{e.message}"
        puts e.backtrace
        exit 1
      end
    end
  end
end

# Process command-line arguments
if ARGV.length >= 2
  platform = ARGV[0].to_sym
  lane = ARGV[1].to_s
  Fastlane::LaneManager.cruise_lane(platform, lane)
else
  puts "Usage: ruby run_lane.rb platform lane_name"
  puts "Example: ruby run_lane.rb android bump_version_and_build"
  exit 1
end