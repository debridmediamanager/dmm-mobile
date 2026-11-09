import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

/**
 * The app's settings, each one a DMM web `settings:*` key so "remember across devices"
 * carries it both ways. Values are DMM web's own (player ids from its Settings list,
 * provider ids), so a choice made on either side means the same thing on the other.
 */
export const SETTINGS = {
	player: { webKey: 'settings:player', storeKey: 'dmm.library.player' },
	addProvider: { webKey: 'settings:addMagnetProvider', storeKey: 'dmm.library.addProvider' },
} as const;

export type SettingName = keyof typeof SETTINGS;
export type AppSettings = Partial<Record<SettingName, string>>;

const listeners = new Set<() => void>();
let cache: AppSettings | null = null;

export async function loadSettings(): Promise<AppSettings> {
	if (cache) return cache;
	const loaded: AppSettings = {};
	if (Platform.OS !== 'web') {
		for (const name of Object.keys(SETTINGS) as SettingName[]) {
			try {
				const value = await SecureStore.getItemAsync(SETTINGS[name].storeKey);
				if (value) loaded[name] = value;
			} catch {
				// A setting that cannot be read falls back to its default.
			}
		}
	}
	cache = loaded;
	return loaded;
}

/** Saves one setting and tells listeners (the sync) that something changed. */
export async function saveSetting(name: SettingName, value: string): Promise<void> {
	const current = await loadSettings();
	cache = { ...current, [name]: value };
	if (Platform.OS !== 'web') await SecureStore.setItemAsync(SETTINGS[name].storeKey, value);
	listeners.forEach((listener) => listener());
}

export function onSettingsChange(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Test seam: forget the in-memory copy. */
export const _resetSettingsCache = () => {
	cache = null;
};
