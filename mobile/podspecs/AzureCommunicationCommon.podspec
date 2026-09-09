Pod::Spec.new do |s|
  s.name = 'AzureCommunicationCommon'
  s.version = '1.3.8'
  s.summary = 'Azure Communication Services common client library for iOS'
  s.homepage = 'https://github.com/Azure/azure-sdk-for-ios'
  s.license = { type: 'MIT' }
  s.author = { 'Azure SDK Mobile Team' => 'azuresdkmobileteam@microsoft.com' }
  s.platform = :ios, '15.0'
  s.swift_version = '5.0'
  s.source = {
    http: 'https://github.com/Azure/azure-sdk-for-ios/releases/download/AzureCommunicationCommon_1.3.8/AzureCommunicationCommon_1.3.8.xcframework.zip',
  }
  s.vendored_frameworks = 'AzureCommunicationCommon.xcframework'
end
