import { Linking, Platform } from 'react-native';
import type { VLCPlayerTracks } from '@lunarr/vlc-player';
import * as IntentLauncher from 'expo-intent-launcher';
import { isVideoName } from './core';
import { loadSettings, saveSetting } from './settings';

/**
 * The players DMM web offers in Settings (src/components/SettingsSection.tsx), with the
 * same ids, so a choice means the same app in both, plus two of the app's own: the
 * built-in player (the default) and 'browser', which hands the link to whatever the system
 * opens for it. DMM web knows neither, so they stay on the device (sync.ts).
 */
export interface PlayerOption {
	id: string;
	label: string;
	/** Android: the activity that takes a video link. expo-intent-launcher ignores a package without one. */
	activity?: string;
}

export const BUILT_IN = 'builtin';
const BUILT_IN_OPTION: PlayerOption = { id: BUILT_IN, label: 'Built-in player' };

export const PLAYERS: Record<'android' | 'ios', PlayerOption[]> = {
	android: [
		BUILT_IN_OPTION,
		{ id: 'browser', label: 'Browser or default app' },
		{ id: 'android/chooser', label: 'Ask which video app' },
		// Read from each app on 2026-11-09: VLC from the Pixel 6 (`cmd package resolve-activity`), Just Player
		// from its F-Droid manifest; MX Player's two from its published intent API.
		{ id: 'android/org.videolan.vlc', label: 'VLC', activity: 'org.videolan.vlc.StartActivity' },
		{ id: 'android/com.mxtech.videoplayer.ad', label: 'MX Player', activity: 'com.mxtech.videoplayer.ad.ActivityScreen' },
		{ id: 'android/com.mxtech.videoplayer.pro', label: 'MX Player Pro', activity: 'com.mxtech.videoplayer.ActivityScreen' },
		{ id: 'android/com.brouken.player', label: 'Just Player', activity: 'com.brouken.player.PlayerActivity' },
	],
	ios: [
		BUILT_IN_OPTION,
		{ id: 'browser', label: 'Safari or default app' },
		{ id: 'ios2/open-vidhub', label: 'VidHub' },
		{ id: 'ios/infuse', label: 'Infuse' },
		{ id: 'ios/vlc', label: 'VLC' },
		{ id: 'ios/outplayer', label: 'Outplayer' },
		{ id: 'ios3/senplayer', label: 'SenPlayer' },
		{ id: 'ios3/aether', label: 'Aether' },
	],
};

// Apple TV has no browser, so a video goes to a player there.
export const playersForPlatform = (): PlayerOption[] =>
	Platform.OS === 'ios' ? (Platform.isTV ? PLAYERS.ios.filter((player) => player.id !== 'browser') : PLAYERS.ios) : PLAYERS.android;

/** The iOS link a player answers, as DMM web's buildPlayerIntent builds it. */
export function iosPlayerUrl(playerId: string, url: string): string {
	const [kind, app] = playerId.split('/');
	if (kind === 'ios') return `${app}://${url.replace(/^https?:\/\//, '')}`;
	// The stream is one query value: a TorBox link carries its own `?token=`, which would otherwise split.
	if (kind === 'ios2') return `${app}://x-callback-url/open?url=${encodeURIComponent(url)}`;
	if (kind === 'ios3') return `${app}://x-callback-url/play?url=${encodeURIComponent(url)}`;
	return url;
}

/** The chosen player, or the built-in one when none is chosen or the synced choice is another platform's (DMM web's 'web/rd', an iOS app on Android). */
export async function loadPlayer(): Promise<string> {
	const saved = (await loadSettings()).player;
	return saved && playersForPlatform().some((player) => player.id === saved) ? saved : playersForPlatform()[0].id;
}

export const savePlayer = (id: string): Promise<void> => saveSetting('player', id);

/**
 * Whether a video that has started plays without sound it has: libVLC lists an audio track it has
 * no decoder for but never selects it, so tracks to choose from and none selected means none decodes.
 */
export const soundUnplayable = (tracks: Pick<VLCPlayerTracks, 'audio' | 'audioIndex'>): boolean => tracks.audioIndex === -1 && tracks.audio.some((track) => track.id !== -1);

/** Whether a file opens in the built-in player rather than in another app. */
export const playsBuiltIn = async (fileName: string): Promise<boolean> => isVideoName(fileName) && (await loadPlayer()) === BUILT_IN;

/**
 * Opens a resolved file link in another app: videos in the chosen player app (or `player`),
 * anything else (subtitles, archives, images) in the system. Throws a readable error when the
 * player is not installed.
 */
export async function openFileLink(url: string, fileName: string, player?: string): Promise<void> {
	player ??= await loadPlayer();
	if (player === 'browser' || player === BUILT_IN || !isVideoName(fileName)) {
		await Linking.openURL(url);
		return;
	}
	const option = playersForPlatform().find((entry) => entry.id === player);
	const label = option?.label ?? player;
	if (Platform.OS === 'android') {
		const pkg = player.split('/')[1];
		try {
			await IntentLauncher.startActivityAsync('android.intent.action.VIEW', { data: url, type: 'video/*', ...(option?.activity ? { packageName: pkg, className: option.activity } : {}) });
		} catch {
			throw new Error(`${label} is not installed, or would not open this file. Choose another player in Settings.`);
		}
		return;
	}
	try {
		await Linking.openURL(iosPlayerUrl(player, url));
	} catch {
		throw new Error(`${label} is not installed. Choose another player in Settings.`);
	}
}
