Pod::Spec.new do |s|
  s.name           = 'VlcPlayer'
  s.version        = '1.0.0'
  s.summary        = 'MobileVLCKit video view for formats AVPlayer cannot open (MKV, AVI, MPEG-TS, …)'
  s.license        = 'MIT'
  s.author         = 'Nova'
  s.homepage       = 'https://github.com/TheLoop705/nova-iptv'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/TheLoop705/nova-iptv.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.dependency 'MobileVLCKit', '~> 3.7'

  s.source_files = '**/*.{h,m,swift}'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
