import { requireNativeModule } from 'expo';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as Updates from 'expo-updates';

/**
 * Fixes over the air (expo-updates, docs/releasing.md) are code that the store the app came from never checked, so they
 * download only with the user's consent (IzzyOnDroid's inclusion policy, "Self-Updaters"). Settings → Get fixes
 * automatically: on by default in an install from Google Play, the Amazon Appstore or the App Store, which already update
 * the app by themselves; off in any other install (the GitHub APK, Obtainium, IzzyOnDroid) until switched on.
 * expo-updates' own check at launch is off (app.json `checkAutomatically: NEVER`), so this is the only automatic one.
 */
const KEY = 'dmm.updates.auto';
const STORES = ['com.android.vending', 'com.amazon.venezia'];

export function fixesOnByDefault(os: string, installer: string | null): boolean {
	return os === 'ios' || STORES.includes(installer ?? '');
}

const installer = (): string | null => (Platform.OS === 'android' ? requireNativeModule('DmmInstaller').installer : null);

export async function autoFixesOn(): Promise<boolean> {
	const saved = await SecureStore.getItemAsync(KEY).catch(() => null);
	return saved ? saved === 'on' : fixesOnByDefault(Platform.OS, installer());
}

export const setAutoFixes = (on: boolean) => SecureStore.setItemAsync(KEY, on ? 'on' : 'off');

/** At start, if allowed: downloads a newer update, which runs from the next start (what `ON_LOAD` did natively). */
export async function fetchFixesOnStart(): Promise<void> {
	if (!Updates.isEnabled || !(await autoFixesOn())) return;
	try {
		if ((await Updates.checkForUpdateAsync()).isAvailable) await Updates.fetchUpdateAsync();
	} catch {
		// Offline or the server is down: the next start tries again.
	}
}
