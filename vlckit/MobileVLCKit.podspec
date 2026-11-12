# VideoLAN's MobileVLCKit with FFmpeg's TrueHD decoder, built by vlckit/build.sh from VLCKit 3.7.5 and
# downloaded by vlckit/fetch.sh. The Podfile takes it from here (plugins/withVlcKit.js); the rest
# is VideoLAN's own podspec.
Pod::Spec.new do |s|
  s.name = 'MobileVLCKit'
  s.version = '3.7.5'
  s.summary = 'MobileVLCKit 3.7.5 with the TrueHD decoder'
  s.homepage = 'https://code.videolan.org/videolan/VLCKit'
  s.license = 'LGPL-2.1-or-later'
  s.author = 'VideoLAN'
  s.source = { :git => 'https://code.videolan.org/videolan/VLCKit.git', :tag => '3.7.5' }
  s.platform = :ios, '12.0'
  raise 'MobileVLCKit.xcframework is missing: run vlckit/fetch.sh' unless File.exist?(File.join(__dir__, 'MobileVLCKit.xcframework'))
  s.vendored_frameworks = 'MobileVLCKit.xcframework'
  s.frameworks = %w[QuartzCore CoreText AVFoundation Security CFNetwork AudioToolbox OpenGLES CoreGraphics VideoToolbox CoreMedia]
  s.libraries = %w[c++ xml2 z bz2 iconv]
  s.requires_arc = false
  s.pod_target_xcconfig = { 'CLANG_CXX_LANGUAGE_STANDARD' => 'c++14', 'CLANG_CXX_LIBRARY' => 'libc++' }
end
