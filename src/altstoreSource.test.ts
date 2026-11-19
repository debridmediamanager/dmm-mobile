import { readFileSync } from 'node:fs';
import app from '../app.json';

// altstore.json is the source AltStore and SideStore read from the repository (docs/releasing.md).
// A slip here leaves iPhone users with a source that lists a file that is not there.
const source = JSON.parse(readFileSync(new URL('../altstore.json', import.meta.url), 'utf8'));

describe('altstore.json', () => {
	const [listed] = source.apps;

	it('lists this app with every field AltStore requires', () => {
		expect(source.apps).toHaveLength(1);
		expect(listed.bundleIdentifier).toBe(app.expo.ios.bundleIdentifier);
		for (const field of ['name', 'developerName', 'localizedDescription', 'iconURL']) {
			expect(listed[field], field).toBeTruthy();
		}
		expect(Array.isArray(listed.appPermissions.entitlements)).toBe(true);
		expect(listed.appPermissions.privacy).toBeTypeOf('object');
	});

	it('names each build by the file its link downloads, newest first', () => {
		expect(listed.versions.length).toBeGreaterThan(0);
		for (const v of listed.versions) {
			expect(v.downloadURL).toBe(
				`https://github.com/debridmediamanager/dmm-mobile/releases/download/v${v.version}/dmm-mobile-${v.version}-${v.buildVersion}-ios.ipa`
			);
			expect(v.size).toBeGreaterThan(1_000_000);
			expect(Number.isNaN(Date.parse(v.date))).toBe(false);
			expect(v.minOSVersion).toMatch(/^\d+\.\d+$/);
		}
		const dates = listed.versions.map((v: { date: string }) => Date.parse(v.date));
		expect(dates).toEqual([...dates].sort((a, b) => b - a));
	});
});
