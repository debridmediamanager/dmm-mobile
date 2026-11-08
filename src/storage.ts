import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import type { ProviderId } from './model';

const prefix = 'dmm.library.provider.';

export interface CredentialStorage {
	get(provider: ProviderId): Promise<string | null>;
	set(provider: ProviderId, token: string): Promise<void>;
	remove(provider: ProviderId): Promise<void>;
}

export const secureCredentialStorage: CredentialStorage = {
	get: async (provider) => {
		if (Platform.OS === 'web') return null;
		return SecureStore.getItemAsync(`${prefix}${provider}`);
	},
	set: async (provider, token) => {
		if (Platform.OS === 'web') throw new Error('Secure credentials are available in the native iOS and Android app only.');
		await SecureStore.setItemAsync(`${prefix}${provider}`, token);
	},
	remove: async (provider) => {
		if (Platform.OS === 'web') return;
		await SecureStore.deleteItemAsync(`${prefix}${provider}`);
	},
};

export const credentialStorageKey = (provider: ProviderId): string => `${prefix}${provider}`;
