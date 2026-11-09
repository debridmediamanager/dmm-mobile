import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ os: 'android', saved: null as string | null }));
vi.mock('react-native', () => ({ Platform: { get OS() { return native.os; } }, Linking: { openURL: vi.fn(async () => undefined) } }));
vi.mock('expo-secure-store', () => ({ getItemAsync: vi.fn(async () => native.saved), setItemAsync: vi.fn(async () => undefined) }));
vi.mock('expo-intent-launcher', () => ({ startActivityAsync: vi.fn(async () => ({})) }));

import { Linking } from 'react-native';
import * as IntentLauncher from 'expo-intent-launcher';
import { iosPlayerUrl, openFileLink } from './player';

const TB = 'https://store-024.weur.tb-cdn.st/zip/1?token=abc&x=1';

beforeEach(() => {
	native.os = 'android';
	native.saved = null;
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
		expect(IntentLauncher.startActivityAsync).toHaveBeenCalledWith('android.intent.action.VIEW', { data: TB, type: 'video/*', packageName: 'org.videolan.vlc' });
		await openFileLink(TB, 'Sintel.en.srt');
		expect(Linking.openURL).toHaveBeenCalledWith(TB);
	});

	it('asks Android for any video app when the chooser is set, and opens normally by default', async () => {
		native.saved = 'android/chooser';
		await openFileLink(TB, 'a.mp4');
		expect(IntentLauncher.startActivityAsync).toHaveBeenCalledWith('android.intent.action.VIEW', { data: TB, type: 'video/*' });
		native.saved = null;
		await openFileLink(TB, 'a.mp4');
		expect(Linking.openURL).toHaveBeenCalledWith(TB);
	});

	it('says to pick another player when the chosen one is not installed', async () => {
		native.saved = 'android/com.brouken.player';
		vi.mocked(IntentLauncher.startActivityAsync).mockRejectedValue(new Error('No Activity found'));
		await expect(openFileLink(TB, 'a.mkv')).rejects.toThrow(/Just Player is not installed/);
	});

	it('ignores a saved player from the other platform', async () => {
		native.saved = 'ios/infuse';
		await openFileLink(TB, 'a.mkv');
		expect(Linking.openURL).toHaveBeenCalledWith(TB);
		expect(IntentLauncher.startActivityAsync).not.toHaveBeenCalled();
	});
});
