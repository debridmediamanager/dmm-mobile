# VideoLAN's TVVLCKit with FFmpeg's TrueHD decoder, built by vlckit/build.sh from VLCKit 3.7.5 and
# downloaded by vlckit/fetch.sh. The Podfile takes it from here (plugins/withVlcKit.js); the rest
# is VideoLAN's own podspec.
Pod::Spec.new do |s|
  s.name = 'TVVLCKit'
  s.version = '3.7.5'
  s.summary = 'TVVLCKit 3.7.5 with the TrueHD decoder'
  s.homepage = 'https://code.videolan.org/videolan/VLCKit'
  s.license = 'LGPL-2.1-or-later'
  s.author = 'VideoLAN'
  s.source = { :git => 'https://code.videolan.org/videolan/VLCKit.git', :tag => '3.7.5' }
  s.platform = :tvos, '10.2'
  raise 'TVVLCKit.xcframework is missing: run vlckit/fetch.sh' unless File.exist?(File.join(__dir__, 'TVVLCKit.xcframework'))
  s.vendored_frameworks = 'TVVLCKit.xcframework'
  s.frameworks = %w[CoreText AVFoundation AudioToolbox OpenGLES VideoToolbox CoreMedia]
  s.libraries = %w[c++ xml2 z bz2 iconv]
  s.requires_arc = false
  s.pod_target_xcconfig = { 'CLANG_CXX_LANGUAGE_STANDARD' => 'c++14', 'CLANG_CXX_LIBRARY' => 'libc++' }
end
