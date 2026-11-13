import { describe, expect, it, vi } from 'vitest';

// The device's file system as a real Apple TV keeps it: an app writes to caches, and documents refuses every save
// (seen 2026-11-13 on Apple TV 4K, tvOS 26.6: Documents stayed empty after three videos played; titles-v1.json in Caches).
const device = vi.hoisted(() => ({ os: 'ios', tv: false, disk: new Map<string, string>() }));
vi.mock('react-native', () => ({ Platform: { get OS() { return device.os; }, get isTV() { return device.tv; } } }));
vi.mock('expo-file-system', () => ({
	Paths: { document: 'Documents', cache: 'Library/Caches' },
	File: class {
		private readonly path: string;
		constructor(dir: string, name: string) {
			this.path = `${dir}/${name}`;
		}
		get exists() {
			return device.disk.has(this.path);
		}
		private writable() {
			if (device.os === 'ios' && device.tv && this.path.startsWith('Documents/')) throw new Error(`You don't have permission to save the file in the folder Documents.`);
		}
		create() {
			this.writable();
			device.disk.set(this.path, '');
		}
		async write(text: string) {
			this.writable();
			device.disk.set(this.path, text);
		}
		async text() {
			return device.disk.get(this.path) ?? '';
		}
	},
}));

import { documentStore, PlaybackStore, playbackKey, type PlaybackEvent } from './playback';
import sightings from './test/fixtures/rd-show-files-sightings-2026-11-12.json';

const memory = () => {
	let text: string | null = null;
	return { read: async () => text, write: async (next: string) => void (text = next), text: () => text };
};
const MIN = 60_000;
const meta = { name: 'Sightings - 1x01 - The UFO Report.mp4', imdbId: 'tt0103558', season: 1, episode: 1 };

describe('playbackKey', () => {
	const release = { provider: 'rd' as const, hash: sightings.hash.toUpperCase(), filename: sightings.filename };
	const file = { name: sightings.files[3].path };

	it('is the provider, the release hash and the file path, so a re-added release resumes', () => {
		expect(playbackKey(release, file)).toBe(`rd:${sightings.hash}:${sightings.files[3].path}`);
		expect(playbackKey({ ...release, provider: 'tb' }, file)).not.toBe(playbackKey(release, file));
	});

	it('uses the release name when the provider gives no hash', () => {
		expect(playbackKey({ provider: 'pm', hash: '', filename: 'Sightings' }, { name: 'a.mp4', path: '/Season 1/' })).toBe('pm:Sightings:Season 1/a.mp4');
	});
});

describe('documentStore', () => {
	it.each([
		['an Apple TV', 'ios', true, 'Library/Caches/playback-v1.json'],
		['an iPhone', 'ios', false, 'Documents/playback-v1.json'],
		['an Android TV', 'android', true, 'Documents/playback-v1.json'],
	])('keeps where a video was left after the app quits on %s', async (_, os, tv, path) => {
		Object.assign(device, { os, tv, disk: new Map() });
		await new PlaybackStore(documentStore('playback-v1.json')).record('k', 20 * MIN, 45 * MIN, meta);
		const restarted = new PlaybackStore(documentStore('playback-v1.json'));
		await restarted.load();
		expect(restarted.resumeAt('k')).toBe(20 * MIN);
		expect([...device.disk.keys()]).toEqual([path]);
	});
});

describe('PlaybackStore', () => {
	it('offers to resume past the first half minute and saves to its file', async () => {
		const file = memory();
		const store = new PlaybackStore(file, () => 1000);
		await store.record('k', 20_000, 45 * MIN, meta);
		expect(store.resumeAt('k')).toBe(0);
		await store.record('k', 20 * MIN + 10_000, 45 * MIN, meta);
		expect(store.resumeAt('k')).toBe(20 * MIN + 10_000);
		const reopened = new PlaybackStore(file);
		await reopened.load();
		expect(reopened.get('k')).toEqual({ ...meta, position: 20 * MIN + 10_000, duration: 45 * MIN, finished: false, updatedAt: 1000 });
	});

	// Trakt's line (live 2026-11-12): a pause at 79.9% is kept as a resume point, one at 80% refused (422), a stop there scrobbled.
	it("marks a file finished from 80%, Trakt's line, and clears its resume point, telling listeners once", async () => {
		const store = new PlaybackStore(memory());
		const events: PlaybackEvent[] = [];
		store.subscribe((event) => events.push(event));
		await store.record('k', 45 * MIN * 0.799, 45 * MIN, meta);
		expect(store.resumeAt('k')).toBe(45 * MIN * 0.799);
		await store.record('k', 45 * MIN * 0.8, 45 * MIN, meta);
		await store.record('k', 45 * MIN, 45 * MIN, meta);
		expect(store.get('k')).toMatchObject({ position: 0, finished: true });
		expect(store.resumeAt('k')).toBe(0);
		expect(events.map((event) => event.ended)).toEqual([false, true, false]);
	});

	it('keeps a watched file watched when it is started over and left at once, not when watched again', async () => {
		const store = new PlaybackStore(memory());
		await store.record('k', 45 * MIN, 45 * MIN, meta);
		await store.record('k', 10_000, 45 * MIN, meta);
		expect(store.get('k')?.finished).toBe(true);
		await store.record('k', 10 * MIN, 45 * MIN, meta);
		expect(store.get('k')?.finished).toBe(false);
		expect(store.resumeAt('k')).toBe(10 * MIN);
	});

	it('lists what was played and forgets a file for good (Continue Watching\'s Remove)', async () => {
		const file = memory();
		const store = new PlaybackStore(file, () => 1000);
		await store.record('k', 20 * MIN, 45 * MIN, meta);
		expect(store.list()).toEqual([['k', { ...meta, position: 20 * MIN, duration: 45 * MIN, finished: false, updatedAt: 1000 }]]);
		const version = store.version;
		await store.forget('k');
		expect(store.version).toBeGreaterThan(version);
		const reopened = new PlaybackStore(file);
		await reopened.load();
		expect(reopened.list()).toEqual([]);
	});

	it('starts empty from an unreadable file', async () => {
		const store = new PlaybackStore({ read: async () => '{not json', write: async () => undefined });
		await store.load();
		expect(store.resumeAt('k')).toBe(0);
	});
});
