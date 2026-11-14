// A self-hosted DMM usually answers on plain http (http://<LAN IP>:3000), which Android refuses in
// release builds unless the app allows it. Providers and debridmediamanager.com are still called over https.
const { AndroidConfig, withAndroidManifest } = require('expo/config-plugins');

module.exports = function withCleartextTraffic(config) {
	return withAndroidManifest(config, (mod) => {
		AndroidConfig.Manifest.getMainApplicationOrThrow(mod.modResults).$['android:usesCleartextTraffic'] = 'true';
		return mod;
	});
};
