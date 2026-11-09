// Release builds for Google Play are signed with the upload key named by the Gradle properties
// DMM_UPLOAD_STORE_FILE, DMM_UPLOAD_STORE_PASSWORD, DMM_UPLOAD_KEY_ALIAS and DMM_UPLOAD_KEY_PASSWORD
// (docs/store/release.md). Without them a release build is signed with the debug key, as before.
const { withAppBuildGradle } = require('expo/config-plugins');

const RELEASE_CONFIG = `
        release {
            if (findProperty('DMM_UPLOAD_STORE_FILE')) {
                storeFile file(findProperty('DMM_UPLOAD_STORE_FILE'))
                storePassword findProperty('DMM_UPLOAD_STORE_PASSWORD')
                keyAlias findProperty('DMM_UPLOAD_KEY_ALIAS')
                keyPassword findProperty('DMM_UPLOAD_KEY_PASSWORD')
            }
        }`;

module.exports = function withReleaseSigning(config) {
	return withAppBuildGradle(config, (mod) => {
		let gradle = mod.modResults.contents;
		if (gradle.includes('DMM_UPLOAD_STORE_FILE')) return mod;
		const debugConfig = /(signingConfigs \{\s*debug \{[^}]*\})/;
		const releaseUse = /(release \{[^{}]*?)signingConfig signingConfigs\.debug/;
		if (!debugConfig.test(gradle) || !releaseUse.test(gradle)) throw new Error('withReleaseSigning: app/build.gradle no longer has the expected signing blocks');
		gradle = gradle.replace(debugConfig, `$1${RELEASE_CONFIG}`);
		gradle = gradle.replace(releaseUse, "$1signingConfig findProperty('DMM_UPLOAD_STORE_FILE') ? signingConfigs.release : signingConfigs.debug");
		mod.modResults.contents = gradle;
		return mod;
	});
};
