import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-file-system', () => ({ File: class {}, Paths: {} }));

import { filePath } from './core';
import type { LibraryFile, LibraryItem } from './model';
import { PlaybackStore, playbackKey, type PlaybackEntry } from './playback';
import { findEpisode, showEpisodes, type ShowEpisodes } from './titles';
import { continueWatching, heldEpisodes, nextUp, releaseFinder, resumable, rowsUpTo, titleStates, WatchStore, watchedFrom, watchKey, type WatchedEntry } from './watched';
import sightings from './test/fixtures/rd-show-files-sightings-2026-11-12.json';
import mushoku from './test/fixtures/rd-show-files-mushoku-tensei-s02-2026-11-12.json';
import identifyFixture from './test/fixtures/dmm-identify-testacct123-2026-11-12.json';
import fireTv from './test/fixtures/firetv-playback-civil-war-2026-11-12.json';

const memory = () => {
	let text: string | null = null;
	return { read: async () => text, write: async (next: string) => void (text = next), text: () => text };
};
const MIN = 60_000;

type Release = { id: string; filename: string; hash: string; files: { id: number; path: string; bytes: number; selected: number }[] };
/** A release as the app holds it once its detail is read (name = Real-Debrid's path). */
const release = (fixture: Release, extra: Partial<LibraryItem> = {}): LibraryItem => ({
	id: `rd:${fixture.id}`,
	provider: 'rd',
	title: fixture.filename,
	filename: fixture.filename,
	hash: fixture.hash,
	size: 1,
	progress: 100,
	status: 'finished',
	serviceStatus: 'downloaded',
	added: '2026-11-01T00:00:00Z',
	files: fixture.files.map((file): LibraryFile => ({ id: String(file.id), name: file.path, size: file.bytes, selected: file.selected === 1 })),
	...extra,
});
const SIGHTINGS = 'tt0103558';
const MUSHOKU = 'tt13293588';
const rdSightings = release(sightings);
const tbSightings = release(sightings, { id: 'tb:42', provider: 'tb' });
const rdMushoku = release(mushoku);
const show = (...items: LibraryItem[]): ShowEpisodes => showEpisodes(items.map((item) => ({ item, files: item.files })));
const sightingsShow = show(rdSightings, tbSightings);
const file = (item: LibraryItem, name: string) => item.files.find((entry) => entry.name.includes(name))!;

/** What the player saves for a file, as PlayerScreen builds its meta. */
const metaOf = (item: LibraryItem, name: string, imdbId: string, episodes: ShowEpisodes) => {
	const found = findEpisode(episodes, item.id, file(item, name).id);
	return { name: file(item, name).name, imdbId, kind: 'tv' as const, season: found?.ref?.season, episode: found?.ref?.episode, end: found?.ref?.end };
};
const marks = (...entries: [number, number, number][]): WatchedEntry[] => entries.map(([season, episode, watchedAt]) => ({ imdbId: SIGHTINGS, season, episode, watchedAt }));
const code = (up: ReturnType<typeof nextUp>) => (up ? `${up.row.season}x${String(up.row.episode).padStart(2, '0')}` : null);

describe('watched from playback (rd6893c80a7036 "Sightings", testacct123 releases, 2026-11-12)', () => {
	it('marks an episode once its file passes 92%, at that save, whichever copy played it', async () => {
		let now = 1000;
		const plays = new PlaybackStore(memory(), () => now);
		const store = new WatchStore(memory());
		store.follow(plays);
		const tbKey = playbackKey(tbSightings, file(tbSightings, '1x01'));
		await plays.record(tbKey, 30 * MIN, 45 * MIN, metaOf(tbSightings, '1x01', SIGHTINGS, sightingsShow));
		expect(store.list()).toEqual([]);
		now = 2000;
		await plays.record(tbKey, 42 * MIN, 45 * MIN, metaOf(tbSightings, '1x01', SIGHTINGS, sightingsShow));
		await vi.waitFor(() => expect(store.list()).toEqual([{ imdbId: SIGHTINGS, season: 1, episode: 1, watchedAt: 2000 }]));
		// Per title, not per copy: the Real-Debrid copy of the same episode is watched too.
		expect(store.watchedAt({ imdbId: SIGHTINGS, season: 1, episode: 1 })).toBe(2000);
	});

	it('marks both episodes of a double episode file (1x06-07)', async () => {
		const plays = new PlaybackStore(memory(), () => 5000);
		const store = new WatchStore(memory());
		store.follow(plays);
		await plays.record(playbackKey(rdSightings, file(rdSightings, '1x06-07')), 88 * MIN, 90 * MIN, metaOf(rdSightings, '1x06-07', SIGHTINGS, sightingsShow));
		await vi.waitFor(() => expect(store.list().map((entry) => entry.episode)).toEqual([6, 7]));
	});

	it('marks nothing for an unnamed file, a show file placed nowhere, or a save that did not just finish', () => {
		const entry = { position: 0, duration: 45 * MIN, finished: true, updatedAt: 1, name: 'x.mkv' };
		expect(watchedFrom({ key: 'k', ended: true, entry })).toEqual([]);
		// Mushoku Tensei's "NCED.01.mkv" (an extra) has the show's id but no episode.
		expect(watchedFrom({ key: 'k', ended: true, entry: { ...entry, imdbId: MUSHOKU, kind: 'tv' } })).toEqual([]);
		expect(watchedFrom({ key: 'k', ended: false, entry: { ...entry, imdbId: 'tt2285752', kind: 'movie' } })).toEqual([]);
		expect(watchedFrom({ key: 'k', ended: true, entry: { ...entry, imdbId: 'tt2285752', kind: 'movie' } })).toEqual([{ imdbId: 'tt2285752' }]);
	});
});

describe('WatchStore marks', () => {
	it('marks and unmarks by hand and keeps Trakt-shaped entries across launches', async () => {
		const file = memory();
		const store = new WatchStore(file, () => 7000);
		await store.set([{ imdbId: 'tt2285752' }, { imdbId: SIGHTINGS, season: 1, episode: 2 }], true);
		await store.set([{ imdbId: SIGHTINGS, season: 1, episode: 2 }], false);
		const relaunched = new WatchStore(file);
		await relaunched.load();
		expect(relaunched.list()).toEqual([{ imdbId: 'tt2285752', watchedAt: 7000 }]);
		expect(JSON.parse(file.text()!)).toEqual({ tt2285752: { imdbId: 'tt2285752', watchedAt: 7000 } });
	});

	it('marks "up to here" through earlier seasons, and specials only among specials', () => {
		const upTo = (name: string) => rowsUpTo(sightingsShow, findEpisode(sightingsShow, rdSightings.id, file(rdSightings, name).id)!.ref!);
		expect(upTo('2x02 -').map((row) => `${row.season}x${row.episode}`)).toEqual(['1x1', '1x2', '1x4', '1x5', '1x6', '1x7', '1x8', '1x9', '1x10', '1x11', '1x12', '1x13', '1x14', '2x1', '2x2']);
		const mushokuShow = show(rdMushoku);
		expect(rowsUpTo(mushokuShow, { season: 0, episode: 2 }).map((row) => `${row.season}x${row.episode}`)).toEqual(['0x2']);
		expect(rowsUpTo(mushokuShow, { season: 2, episode: 3 }).map((row) => `${row.season}x${row.episode}`)).toEqual(['2x1', '2x2', '2x3']);
	});
});

describe('nextUp', () => {
	it('follows the episode watched last, past a gap and a double episode, into the next season', () => {
		expect(code(nextUp(SIGHTINGS, sightingsShow, marks([1, 1, 10])))).toBe('1x02');
		// 1x03 is not in the library.
		expect(code(nextUp(SIGHTINGS, sightingsShow, marks([1, 1, 10], [1, 2, 20])))).toBe('1x04');
		// The "1x06-07" file marks both.
		expect(code(nextUp(SIGHTINGS, sightingsShow, marks([1, 6, 30], [1, 7, 30])))).toBe('1x08');
		expect(code(nextUp(SIGHTINGS, sightingsShow, marks([1, 14, 40])))).toBe('2x01');
		expect(nextUp(SIGHTINGS, sightingsShow, marks([5, 18, 50]))).toBeNull();
		expect(nextUp(SIGHTINGS, sightingsShow, [])).toBeNull();
	});

	it('moves past a season marked watched at once, skips what is watched, and looks forward only', () => {
		const season1 = heldEpisodes(sightingsShow).filter((row) => row.season === 1).map((row): [number, number, number] => [1, row.episode, 60]);
		expect(code(nextUp(SIGHTINGS, sightingsShow, marks(...season1)))).toBe('2x01');
		// 1x01-1x05 watched, then 1x02 again: next is the first unwatched after it.
		expect(code(nextUp(SIGHTINGS, sightingsShow, marks([1, 1, 1], [1, 4, 4], [1, 5, 5], [1, 2, 9])))).toBe('1x06');
		// Only 1x09 watched: 1x01-1x08 stay behind.
		expect(code(nextUp(SIGHTINGS, sightingsShow, marks([1, 9, 1])))).toBe('1x10');
	});

	it('never leads from or to specials (Mushoku Tensei S02 with S00E02, testacct123)', () => {
		const mushokuShow = show(rdMushoku);
		const mark = (season: number, episode: number, watchedAt: number) => ({ imdbId: MUSHOKU, season, episode, watchedAt });
		expect(nextUp(MUSHOKU, mushokuShow, [mark(0, 2, 5)])).toBeNull();
		expect(code(nextUp(MUSHOKU, mushokuShow, [mark(2, 5, 1), mark(0, 2, 5)]))).toBe('2x06');
		expect(nextUp(MUSHOKU, mushokuShow, [mark(2, 24, 1)])).toBeNull();
		// Its NC openings and endings stay unplaced and out of every count.
		expect(mushokuShow.unplaced.map((copy) => copy.label)).toEqual(['NCs/NCED.01.mkv', 'NCs/NCED.02.mkv', 'NCs/NCOP.01.mkv', 'NCs/NCOP.02.mkv']);
		expect(heldEpisodes(mushokuShow)).toHaveLength(24);
	});

	it('plays it from the release played before, then that provider', () => {
		const up = (before?: LibraryItem) => nextUp(SIGHTINGS, sightingsShow, marks([1, 1, 1]), before)?.copy.item.id;
		expect(up(tbSightings)).toBe('tb:42');
		expect(up(rdSightings)).toBe(rdSightings.id);
		expect(up()).toBe(rdSightings.id);
	});
});

describe('continueWatching', () => {
	const southPark = identifyFixture.items[0];
	const library: LibraryItem[] = [rdSightings, tbSightings, { ...release({ ...southPark, id: southPark.id.slice(3), files: [] }) }, { ...rdSightings, id: 'pm:1', provider: 'pm', hash: '', filename: 'Sightings: Season 1' }];
	const entry = (updatedAt: number, position: number, extra: object = {}) => ({ position, duration: 45 * MIN, finished: false, updatedAt, name: 'f.mkv', ...extra });

	it('lists files left part way, latest first, one per title, from releases still in the library', () => {
		const key = (item: LibraryItem, name: string) => playbackKey(item, file(item, name));
		const rows = continueWatching(
			[
				[key(rdSightings, '1x02'), entry(10, 20 * MIN, { imdbId: SIGHTINGS, kind: 'tv', season: 1, episode: 2 })],
				[key(tbSightings, '1x04'), entry(30, 5 * MIN, { imdbId: SIGHTINGS, kind: 'tv', season: 1, episode: 4 })],
				['rd:3c50a9e66077b0132047916f2ee862f4716adf59:South Park S01E01.mkv', entry(20, 12 * MIN, { imdbId: 'tt0121955', kind: 'tv', season: 1, episode: 1 })],
				// A hashless Premiumize release whose name holds a colon.
				['pm:Sightings: Season 1:Sightings - 1x05.mp4', entry(25, 3 * MIN)],
				// Under half a minute in, finished, or deleted from the library: not listed.
				['rd:3c50a9e66077b0132047916f2ee862f4716adf59:a.mkv', entry(40, 20_000)],
				['rd:3c50a9e66077b0132047916f2ee862f4716adf59:b.mkv', { ...entry(41, 0), finished: true }],
				['rd:0000000000000000000000000000000000000000:c.mkv', entry(42, 9 * MIN, { imdbId: 'tt1' })],
			],
			library,
			() => undefined
		);
		expect(rows.map((row) => [row.item.id, row.path])).toEqual([
			// What resuming looks the file up by.
			['tb:42', filePath(file(tbSightings, '1x04').name)],
			['pm:1', 'Sightings - 1x05.mp4'],
			['rd:2CHSZZUOPVH3Q', 'South Park S01E01.mkv'],
		]);
	});

	// On the Fire TV: S01E01 left at 1:30, then S01E02 played to the end and S01E03 left at 0:05. E01 came back.
	it("lets a title's latest playback decide, so an earlier episode left part way does not come back", () => {
		const items = fireTv.releases.map((entry, n) => ({ ...rdSightings, id: `rd:${n}`, ...entry, provider: 'rd' as const }));
		const marks = fireTv.watched as Record<string, WatchedEntry>;
		const playback = Object.entries(fireTv.playback) as [string, PlaybackEntry][];
		expect(continueWatching(playback, items, (ref) => marks[watchKey(ref)]?.watchedAt)).toEqual([]);
		// Left at 2:23 instead, E03 is what Continue Watching offers.
		const later = playback.map(([key, entry]): [string, PlaybackEntry] => [key, key.includes('S01E03') ? { ...entry, position: 143_000 } : entry]);
		expect(continueWatching(later, items, (ref) => marks[watchKey(ref)]?.watchedAt).map((row) => row.entry.episode)).toEqual([3]);
	});

	it('drops a file once its episode or film is watched on any copy, until it is played again', () => {
		const key = playbackKey(rdSightings, file(rdSightings, '1x02'));
		const left = entry(10, 20 * MIN, { imdbId: SIGHTINGS, kind: 'tv', season: 1, episode: 2 });
		const at = (when?: number) => () => when;
		expect(continueWatching([[key, left]], library, at(11))).toEqual([]);
		expect(continueWatching([[key, left]], library, at(9))).toHaveLength(1);
		expect(releaseFinder(library)(key)?.item.id).toBe(rdSightings.id);
	});
});

describe('titleStates', () => {
	const group = (items: LibraryItem[], imdbId: string, kind: 'movie' | 'tv') => ({ imdbId, title: 'T', year: null, kind, items, added: 0, seasons: [] });

	it('counts a show by the episodes the library holds, and shows a film in progress or watched', () => {
		const groups = [group([rdSightings, tbSightings], SIGHTINGS, 'tv'), group([], 'tt2285752', 'movie'), group([], 'tt1727587', 'movie'), group([], 'tt0000001', 'tv')];
		const held = heldEpisodes(sightingsShow).length;
		const playing = resumable([['tb:x:tos.mp4', { position: 6 * MIN, duration: 12 * MIN, finished: false, updatedAt: 50, name: 'tos.mp4', imdbId: 'tt2285752', kind: 'movie' }]]);
		const states = titleStates(groups, () => sightingsShow, [...marks([1, 1, 1], [1, 2, 2], [1, 6, 3], [1, 7, 3]), { imdbId: 'tt1727587', watchedAt: 4 }], playing);
		expect(states.get(SIGHTINGS)).toEqual({ watched: false, progress: 4 / held, label: `4 of ${held}` });
		expect(states.get('tt2285752')).toEqual({ watched: false, progress: 0.5 });
		expect(states.get('tt1727587')).toEqual({ watched: true, progress: 0 });
		expect(states.has('tt0000001')).toBe(false);
	});
});
