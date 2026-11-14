import { Linking, Platform } from 'react-native';
import type { Chapter, PlayerTracks } from './video';
import type { NativeStackNavigationOptions } from '@react-navigation/native-stack';
import * as IntentLauncher from 'expo-intent-launcher';
import { isVideoName } from './core';
import { loadSettings, saveSetting } from './settings';

/** The built-in player's screen: full screen, landscape on phones and tablets (TVs are), the remote's Back or Menu leaves. */
export const PLAYER_SCREEN: NativeStackNavigationOptions = {
	headerShown: false,
	orientation: 'landscape',
	statusBarHidden: true,
	navigationBarHidden: true,
	autoHideHomeIndicator: true,
	contentStyle: { backgroundColor: '#000' },
	// iOS 26 pops a screen on a rightward drag anywhere in it, which took the seek bar's drags: back is from the edge only.
	fullScreenGestureEnabled: false,
};

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
 * no decoder for but never selects it (Media3 likewise), so tracks to choose from and none selected means none decodes.
 */
export const soundUnplayable = (tracks: Pick<PlayerTracks, 'audio' | 'audioIndex'>): boolean => tracks.audioIndex === -1 && tracks.audio.some((track) => track.id !== -1);

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

/** When a video ends if it plays on from `time` at `rate` (ms on the device's clock). */
export const endsAt = (now: number, time: number, duration: number, rate = 1): number => now + Math.max(0, duration - time) / rate;

export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

/** How the picture fills the screen: libVLC's own framing, or the view itself shaped to a ratio the picture is stretched into. */
export type Fit = 'contain' | 'cover' | 'center' | '16:9' | '4:3';
export const FITS: { fit: Fit; label: string }[] = [
	{ fit: 'contain', label: 'Fit' },
	{ fit: 'cover', label: 'Fill (zoom)' },
	// The wrapper draws 'center' at the picture's own pixels on Android only; iOS fits it like 'contain'.
	...(Platform.OS === 'android' ? [{ fit: 'center' as const, label: 'Original size' }] : []),
	{ fit: '16:9', label: '16:9' },
	{ fit: '4:3', label: '4:3' },
];

/** The largest `ratio` ("16:9") box inside a screen, centred. */
export function ratioBox(width: number, height: number, ratio: string): { left: number; top: number; width: number; height: number } {
	const [w, h] = ratio.split(':').map(Number);
	const box = width / height > w / h ? { width: Math.round((height * w) / h), height } : { width, height: Math.round((width * h) / w) };
	return { ...box, left: Math.round((width - box.width) / 2), top: Math.round((height - box.height) / 2) };
}

/** The sleep timer: off, at the end of what plays, or at a time (ms). */
export type Sleep = null | 'end' | number;
export const SLEEP_MINUTES = [15, 30, 60];
/** "12 min left", "End of episode", "Off". */
export const sleepLabel = (sleep: Sleep, now: number, kind?: 'movie' | 'tv'): string =>
	sleep === null ? 'Off' : sleep === 'end' ? `End of ${kind === 'tv' ? 'episode' : kind === 'movie' ? 'film' : 'video'}` : `${Math.max(1, Math.ceil((sleep - now) / 60_000))} min left`;

/** A file's chapters worth showing: one chapter spanning the whole file is none. */
export const chaptersOf = (tracks: Pick<PlayerTracks, 'chapters'> | null): Chapter[] => (tracks && tracks.chapters.length > 1 ? tracks.chapters : []);
/** The chapter playing at `ms`: the last one started by then, -1 before the first. */
export const chapterAt = (chapters: Chapter[], ms: number): number => chapters.findLastIndex((chapter) => chapter.time <= ms);
/** The chapter's own name, else its number: "Chapter 06". */
export const chapterName = (chapters: Chapter[], index: number): string => chapters[index]?.name.trim() || `Chapter ${String(index + 1).padStart(2, '0')}`;
/** Where the seek bar marks chapter starts, as fractions of the duration: not the start of the file, nothing past its end. */
export const chapterMarks = (chapters: Chapter[], duration: number): number[] => (duration > 0 ? chapters.map((chapter) => chapter.time / duration).filter((at) => at > 0 && at < 1) : []);
