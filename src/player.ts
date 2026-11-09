import { Linking, Platform } from 'react-native';
import * as IntentLauncher from 'expo-intent-launcher';
import * as SecureStore from 'expo-secure-store';
import { isVideoName } from './core';

/**
 * The players DMM web offers in Settings (src/components/SettingsSection.tsx), with the
 * same ids, so a choice means the same app in both. 'browser' is this app's default:
 * hand the link to whatever the system opens for it.
 */
export interface PlayerOption {
	id: string;
	label: string;
}

export const PLAYERS: Record<'android' | 'ios', PlayerOption[]> = {
	android: [
		{ id: 'browser', label: 'Browser or default app' },
		{ id: 'android/chooser', label: 'Ask which video app' },
		{ id: 'android/org.videolan.vlc', label: 'VLC' },
		{ id: 'android/com.mxtech.videoplayer.ad', label: 'MX Player' },
		{ id: 'android/com.mxtech.videoplayer.pro', label: 'MX Player Pro' },
		{ id: 'android/com.brouken.player', label: 'Just Player' },
	],
	ios: [
		{ id: 'browser', label: 'Safari or default app' },
		{ id: 'ios2/open-vidhub', label: 'VidHub' },
		{ id: 'ios/infuse', label: 'Infuse' },
		{ id: 'ios/vlc', label: 'VLC' },
		{ id: 'ios/outplayer', label: 'Outplayer' },
		{ id: 'ios3/senplayer', label: 'SenPlayer' },
		{ id: 'ios3/aether', label: 'Aether' },
	],
};

export const playersForPlatform = (): PlayerOption[] => (Platform.OS === 'ios' ? PLAYERS.ios : PLAYERS.android);

/** The iOS link a player answers, as DMM web's buildPlayerIntent builds it. */
export function iosPlayerUrl(playerId: string, url: string): string {
	const [kind, app] = playerId.split('/');
	if (kind === 'ios') return `${app}://${url.replace(/^https?:\/\//, '')}`;
	// The stream is one query value: a TorBox link carries its own `?token=`, which would otherwise split.
	if (kind === 'ios2') return `${app}://x-callback-url/open?url=${encodeURIComponent(url)}`;
	if (kind === 'ios3') return `${app}://x-callback-url/play?url=${encodeURIComponent(url)}`;
	return url;
}

const KEY = 'dmm.library.player';

export async function loadPlayer(): Promise<string> {
	if (Platform.OS === 'web') return 'browser';
	try {
		const saved = await SecureStore.getItemAsync(KEY);
		return saved && playersForPlatform().some((player) => player.id === saved) ? saved : 'browser';
	} catch {
		return 'browser';
	}
}

export async function savePlayer(id: string): Promise<void> {
	if (Platform.OS !== 'web') await SecureStore.setItemAsync(KEY, id);
}

/**
 * Opens a resolved file link: videos go to the chosen player, anything else (subtitles,
 * archives, images) to the system as before. Throws a readable error when the player is
 * not installed.
 */
export async function openFileLink(url: string, fileName: string): Promise<void> {
	const player = await loadPlayer();
	if (player === 'browser' || !isVideoName(fileName)) {
		await Linking.openURL(url);
		return;
	}
	const label = playersForPlatform().find((option) => option.id === player)?.label ?? player;
	if (Platform.OS === 'android') {
		const pkg = player.split('/')[1];
		try {
			await IntentLauncher.startActivityAsync('android.intent.action.VIEW', { data: url, type: 'video/*', ...(pkg === 'chooser' ? {} : { packageName: pkg }) });
		} catch {
			throw new Error(`${label} is not installed, or would not open this file. Choose another player in Accounts.`);
		}
		return;
	}
	try {
		await Linking.openURL(iosPlayerUrl(player, url));
	} catch {
		throw new Error(`${label} is not installed. Choose another player in Accounts.`);
	}
}
