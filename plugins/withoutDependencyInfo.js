// Android builds sign a block of Google's into the APK and the bundle: the app's dependency list, encrypted so that only
// Google can read it. IzzyOnDroid's scanner flags it as unverifiable (izzyondroid.org/about/security/ApkScans).
const { withAppBuildGradle } = require('expo/config-plugins');

const BLOCK = `
    dependenciesInfo {
        includeInApk = false
        includeInBundle = false
    }`;

module.exports = function withoutDependencyInfo(config) {
	return withAppBuildGradle(config, (mod) => {
		if (mod.modResults.contents.includes('dependenciesInfo')) return mod;
		if (!/^android \{$/m.test(mod.modResults.contents)) throw new Error('withoutDependencyInfo: app/build.gradle no longer has its android block');
		mod.modResults.contents = mod.modResults.contents.replace(/^android \{$/m, `android {${BLOCK}`);
		return mod;
	});
};
