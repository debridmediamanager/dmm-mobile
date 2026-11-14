import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => new Map<string, string>());
const device = vi.hoisted(() => ({ os: 'android', installer: null as string | null }));
const updates = vi.hoisted(() => ({ isEnabled: true, checkForUpdateAsync: vi.fn(), fetchUpdateAsync: vi.fn() }));
vi.mock('react-native', () => ({ Platform: { get OS() { return device.os; } } }));
vi.mock('expo-secure-store', () => ({
	getItemAsync: vi.fn(async (key: string) => store.get(key) ?? null),
	setItemAsync: vi.fn(async (key: string, value: string) => void store.set(key, value)),
}));
vi.mock('expo-updates', () => updates);
vi.mock('expo', () => ({ requireNativeModule: () => ({ get installer() { return device.installer; } }) }));

import { autoFixesOn, fetchFixesOnStart, fixesOnByDefault, setAutoFixes } from './updates';

beforeEach(() => {
	store.clear();
	device.os = 'android';
	device.installer = null;
	updates.isEnabled = true;
	updates.checkForUpdateAsync.mockResolvedValue({ isAvailable: true });
	updates.fetchUpdateAsync.mockResolvedValue({ isNew: true });
});

describe('fixes over the air', () => {
	it('are on by default only where a store installed the app', () => {
		expect(fixesOnByDefault('android', 'com.android.vending')).toBe(true);
		expect(fixesOnByDefault('android', 'com.amazon.venezia')).toBe(true);
		expect(fixesOnByDefault('ios', null)).toBe(true);
		for (const other of [null, 'dev.imranr.obtainium', 'org.fdroid.fdroid', 'com.google.android.packageinstaller']) expect(fixesOnByDefault('android', other)).toBe(false);
	});

	it('never ask the update server from a sideloaded APK that was not switched on', async () => {
		await fetchFixesOnStart();
		expect(updates.checkForUpdateAsync).not.toHaveBeenCalled();
		expect(updates.fetchUpdateAsync).not.toHaveBeenCalled();
	});

	it('download at start once switched on, and stop when switched off again', async () => {
		await setAutoFixes(true);
		expect(await autoFixesOn()).toBe(true);
		await fetchFixesOnStart();
		expect(updates.fetchUpdateAsync).toHaveBeenCalledTimes(1);

		device.installer = 'com.android.vending';
		await setAutoFixes(false);
		await fetchFixesOnStart();
		expect(updates.checkForUpdateAsync).toHaveBeenCalledTimes(1);
	});

	it('download at start from a Play install, only when an update is newer', async () => {
		device.installer = 'com.android.vending';
		updates.checkForUpdateAsync.mockResolvedValue({ isAvailable: false });
		await fetchFixesOnStart();
		expect(updates.checkForUpdateAsync).toHaveBeenCalledTimes(1);
		expect(updates.fetchUpdateAsync).not.toHaveBeenCalled();
	});

	it('leave a failed check for the next start', async () => {
		device.os = 'ios';
		updates.checkForUpdateAsync.mockRejectedValue(new Error('Network request failed'));
		await expect(fetchFixesOnStart()).resolves.toBeUndefined();
	});

	it('do nothing in a build without updates', async () => {
		updates.isEnabled = false;
		await setAutoFixes(true);
		await fetchFixesOnStart();
		expect(updates.checkForUpdateAsync).not.toHaveBeenCalled();
	});
});
