// VideoLAN's MobileVLCKit and TVVLCKit leave out FFmpeg's TrueHD decoder (VLCKit's patch 0003), so a
// file whose only sound is TrueHD played silent on iPhone, iPad and Apple TV (2026-11-12). The pods
// come from our build of the same VLCKit with the decoder instead: vlckit/build.sh, vlckit/fetch.sh.
const { withPodfile } = require('expo/config-plugins');

// Chosen when pods install, as @lunarr/vlc-player chooses: config-tv turns `platform :ios` into `platform :tvos`.
const POD = "  pod(File.read(__FILE__).match?(/^platform :tvos/) ? 'TVVLCKit' : 'MobileVLCKit', :path => '../vlckit')";

module.exports = function withVlcKit(config) {
	return withPodfile(config, (mod) => {
		if (!mod.modResults.contents.includes(POD)) mod.modResults.contents = mod.modResults.contents.replace(/^(\s*use_expo_modules!)$/m, `$1\n${POD}`);
		return mod;
	});
};
