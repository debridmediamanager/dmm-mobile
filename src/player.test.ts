import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ os: 'android', tv: false, saved: null as string | null }));
vi.mock('react-native', () => ({ Platform: { get OS() { return native.os; }, get isTV() { return native.tv; } }, Linking: { openURL: vi.fn(async () => undefined) } }));
vi.mock('expo-secure-store', () => ({ getItemAsync: vi.fn(async () => native.saved), setItemAsync: vi.fn(async () => undefined) }));
vi.mock('expo-intent-launcher', () => ({ startActivityAsync: vi.fn(async () => ({})) }));

import { Linking } from 'react-native';
import * as IntentLauncher from 'expo-intent-launcher';
import { endsAt, iosPlayerUrl, loadPlayer, openFileLink, PLAYER_SCREEN, playersForPlatform, playsBuiltIn, ratioBox, sleepLabel, soundUnplayable } from './player';
import { _resetSettingsCache } from './settings';

const TB = 'https://store-024.weur.tb-cdn.st/zip/1?token=abc&x=1';

beforeEach(() => {
	native.os = 'android';
	native.tv = false;
	native.saved = null;
	_resetSettingsCache();
	vi.mocked(Linking.openURL).mockClear();
	vi.mocked(IntentLauncher.startActivityAsync).mockReset().mockResolvedValue({} as never);
});

describe('external players', () => {
	it('builds the iOS links DMM web builds, keeping a TorBox token inside one query value', () => {
		expect(iosPlayerUrl('ios/infuse', 'https://host/d/ABC/Sintel.mp4')).toBe('infuse://host/d/ABC/Sintel.mp4');
		expect(iosPlayerUrl('ios2/open-vidhub', TB)).toBe(`open-vidhub://x-callback-url/open?url=${encodeURIComponent(TB)}`);
		expect(iosPlayerUrl('ios3/senplayer', TB)).toBe(`senplayer://x-callback-url/play?url=${encodeURIComponent(TB)}`);
	});

	it('sends videos to the chosen Android app and everything else to the system', async () => {
		native.saved = 'android/org.videolan.vlc';
		await openFileLink(TB, 'Sintel.mkv');
		// A package alone is ignored by expo-intent-launcher: on the Pixel 6 it showed Android's picker (Photos, VLC).
		expect(IntentLauncher.startActivityAsync).toHaveBeenCalledWith('android.intent.action.VIEW', { data: TB, type: 'video/*', packageName: 'org.videolan.vlc', className: 'org.videolan.vlc.StartActivity' });
		await openFileLink(TB, 'Sintel.en.srt');
		expect(Linking.openURL).toHaveBeenCalledWith(TB);
	});

	it('asks Android for any video app when the chooser is set', async () => {
		native.saved = 'android/chooser';
		await openFileLink(TB, 'a.mp4');
		expect(IntentLauncher.startActivityAsync).toHaveBeenCalledWith('android.intent.action.VIEW', { data: TB, type: 'video/*' });
	});

	it('opens in another app the player asks for, whatever is chosen (the built-in player\'s fallback)', async () => {
		await openFileLink(TB, 'a.mkv', 'android/org.videolan.vlc');
		expect(IntentLauncher.startActivityAsync).toHaveBeenCalledWith('android.intent.action.VIEW', expect.objectContaining({ packageName: 'org.videolan.vlc' }));
	});

	it('says to pick another player when the chosen one is not installed', async () => {
		native.saved = 'android/com.brouken.player';
		vi.mocked(IntentLauncher.startActivityAsync).mockRejectedValue(new Error('No Activity found'));
		await expect(openFileLink(TB, 'a.mkv')).rejects.toThrow(/Just Player is not installed.*Choose another player in Settings/);
	});

	it('ignores a saved player from the other platform', async () => {
		native.saved = 'ios/infuse';
		expect(await loadPlayer()).toBe('builtin');
		expect(IntentLauncher.startActivityAsync).not.toHaveBeenCalled();
	});
});

describe('the built-in player', () => {
	it('leaves its screen only by the edge swipe, so dragging the seek bar to the right does not close it on iOS 26 and later', () => {
		// Seen on an iPhone 15 Pro (iOS 27): a drag along the seek bar popped the player (rightward) or cancelled the scrub (leftward).
		expect(PLAYER_SCREEN.fullScreenGestureEnabled).toBe(false);
		expect(PLAYER_SCREEN.gestureEnabled).not.toBe(false);
	});
	it('is the default where nothing is chosen, and plays only videos', async () => {
		expect(playersForPlatform()[0]).toEqual({ id: 'builtin', label: 'Built-in player' });
		expect(await loadPlayer()).toBe('builtin');
		expect(await playsBuiltIn('Sightings - 1x01 - The UFO Report.mp4')).toBe(true);
		expect(await playsBuiltIn('tears_of_steel.en.srt')).toBe(false);
	});

	it('gives way to a player chosen here or synced from DMM web, but not to one this platform lacks', async () => {
		native.saved = 'android/org.videolan.vlc';
		expect(await loadPlayer()).toBe('android/org.videolan.vlc');
		expect(await playsBuiltIn('a.mkv')).toBe(false);
		// DMM web's own default, synced from a desktop browser.
		native.saved = 'web/rd';
		_resetSettingsCache();
		expect(await loadPlayer()).toBe('builtin');
	});
});

describe('players on Apple TV', () => {
	it('offers no browser, which tvOS lacks, and starts on the built-in player', async () => {
		native.os = 'ios';
		native.tv = true;
		expect(playersForPlatform().map((player) => player.id)).not.toContain('browser');
		expect(await loadPlayer()).toBe('builtin');
		native.saved = 'browser';
		_resetSettingsCache();
		// A browser choice synced from an iPhone falls back to the built-in player here.
		expect(await loadPlayer()).toBe('builtin');
	});
});

describe('sound the built-in player cannot decode', () => {
	// libVLC's track lists as VideoLAN's MobileVLCKit 3.7.5 gave them (vlckit/check/sound.c in the simulator, 2026-11-12).
	const disable = { id: -1, name: 'Disable' };
	it('is told apart when every audio track is listed and none plays (a TrueHD-only episode without the decoder)', () => {
		expect(soundUnplayable({ audio: [disable, { id: 1, name: 'Track 1 - [English]' }, { id: 2, name: 'Track 2 - [Japanese]' }], audioIndex: -1 })).toBe(true);
	});
	it('is not when another track plays (TrueHD with AC3 beside it) or the video has no sound at all', () => {
		expect(soundUnplayable({ audio: [disable, { id: 0, name: 'TrueHD 5.1 - [English]' }, { id: 1, name: 'AC-3 5.1 - [English]' }], audioIndex: 1 })).toBe(false);
		expect(soundUnplayable({ audio: [disable, { id: 0, name: 'TrueHD 5.1 - [English]' }], audioIndex: 0 })).toBe(false);
		expect(soundUnplayable({ audio: [], audioIndex: -1 })).toBe(false);
		expect(soundUnplayable({ audio: [disable], audioIndex: -1 })).toBe(false);
	});
});

describe('player controls', () => {
	const NOW = Date.parse('2026-11-13T21:00:00Z');

	it('ends at the time left, sooner when played faster', () => {
		// 50 s into a 24:53 episode
		expect(endsAt(NOW, 50_000, 1_493_000, 1) - NOW).toBe(1_443_000);
		expect(endsAt(NOW, 50_000, 1_493_000, 1.5) - NOW).toBe(962_000);
		expect(endsAt(NOW, 1_500_000, 1_493_000)).toBe(NOW);
	});

	it('shapes the picture to a ratio inside the screen', () => {
		// Pixel 6 in landscape
		expect(ratioBox(2400, 1080, '16:9')).toEqual({ left: 240, top: 0, width: 1920, height: 1080 });
		expect(ratioBox(2400, 1080, '4:3')).toEqual({ left: 480, top: 0, width: 1440, height: 1080 });
		// the same phone in portrait
		expect(ratioBox(1080, 2400, '16:9')).toEqual({ left: 0, top: 896, width: 1080, height: 608 });
	});

	it('names the sleep timer', () => {
		expect(sleepLabel(null, NOW)).toBe('Off');
		expect(sleepLabel('end', NOW, 'tv')).toBe('End of episode');
		expect(sleepLabel('end', NOW, 'movie')).toBe('End of film');
		expect(sleepLabel(NOW + 15 * 60_000, NOW)).toBe('15 min left');
		expect(sleepLabel(NOW + 14 * 60_000 + 1, NOW)).toBe('15 min left');
		expect(sleepLabel(NOW + 5_000, NOW)).toBe('1 min left');
	});
});
