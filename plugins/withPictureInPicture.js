// Android's picture in picture for the built-in player: the main activity may shrink into a floating
// window, and takes the size change itself instead of being restarted (which would reload the app).
const { AndroidConfig, withAndroidManifest } = require('expo/config-plugins');

const CHANGES = ['orientation', 'screenLayout', 'screenSize', 'smallestScreenSize'];

module.exports = function withPictureInPicture(config) {
	return withAndroidManifest(config, (mod) => {
		const activity = AndroidConfig.Manifest.getMainActivityOrThrow(mod.modResults);
		activity.$['android:supportsPictureInPicture'] = 'true';
		const changes = new Set((activity.$['android:configChanges'] ?? '').split('|').filter(Boolean));
		CHANGES.forEach((change) => changes.add(change));
		activity.$['android:configChanges'] = [...changes].join('|');
		return mod;
	});
};
