require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

# @zharp/react-native's iOS side: Zharp for iOS (crashes, hangs) under the app's JavaScript.
# Zharp for iOS is a Swift package; React Native 0.75+ pulls it in through spm_dependency.
Pod::Spec.new do |s|
  s.name         = "zharp-react-native"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = package["homepage"]
  s.license      = package["license"]
  s.authors      = "Zharp"
  s.platforms    = { :ios => "15.0" }
  s.source       = { :git => "https://github.com/zharp-io/zharp-javascript-lib.git", :tag => "react-native/#{s.version}" }
  s.source_files = "ios/**/*.{h,m,mm,swift}"
  s.swift_version = "5.9"

  install_modules_dependencies(s)

  # ZHARP_IOS_BRANCH: build against a branch of zharp-ios-lib (testing an unreleased version).
  requirement = ENV["ZHARP_IOS_BRANCH"] ?
    { kind: "branch", branch: ENV["ZHARP_IOS_BRANCH"] } :
    { kind: "upToNextMajorVersion", minimumVersion: "0.5.0" }
  spm_dependency(s, url: "https://github.com/zharp-io/zharp-ios-lib.git", requirement: requirement, products: ["Zharp"])
end
