// libVLC's Java classes are reached from its native code only (JNI), so R8 drops them from a
// minified release build and the player's first use exits the app ("FindClass(org/videolan/libvlc/
// MediaDiscoverer) failed", Pixel 6, 2026-11-12). @lunarr/vlc-player ships no keep rule for them.
const fs = require('fs');
const path = require('path');
const { withDangerousMod } = require('expo/config-plugins');

const RULE = '-keep class org.videolan.libvlc.** { *; }';

module.exports = function withLibVlcKeep(config) {
	return withDangerousMod(config, [
		'android',
		async (mod) => {
			const file = path.join(mod.modRequest.platformProjectRoot, 'app', 'proguard-rules.pro');
			const rules = fs.readFileSync(file, 'utf8');
			if (!rules.includes(RULE)) fs.writeFileSync(file, `${rules.trimEnd()}\n# libVLC (built-in player): called from native code\n${RULE}\n`);
			return mod;
		},
	]);
};
