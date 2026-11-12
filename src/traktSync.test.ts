import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-secure-store', () => ({ getItemAsync: vi.fn(async () => null), setItemAsync: vi.fn(), deleteItemAsync: vi.fn() }));
vi.mock('expo-file-system', () => ({ File: class {}, Paths: {} }));

import type { PlaybackEntry } from './playback';
import { TraktAccount } from './trakt';
import { playbackFromTrakt, TraktSync, watchedFromTrakt, type TraktHttp, type TraktReply } from './traktSync';
import { otherDevice, remoteResumes, WatchStore, watchKey, type WatchRef } from './watched';
import activities from './test/fixtures/trakt-last-activities-2026-11-09.json';
import moviesPage1 from './test/fixtures/trakt-watched-movies-p1-2026-11-09.json';
import moviesPage2 from './test/fixtures/trakt-watched-movies-p2-2026-11-09.json';
import shows from './test/fixtures/trakt-watched-shows-2026-11-09.json';
import stopEpisode from './test/fixtures/trakt-scrobble-stop-episode-2026-11-12.json';
import stopAgain from './test/fixtures/trakt-scrobble-stop-409-2026-11-12.json';
import pauseMovie from './test/fixtures/trakt-scrobble-pause-movie-2026-11-12.json';
import historyAdd from './test/fixtures/trakt-history-add-2026-11-12.json';
import historyAddAll from './test/fixtures/trakt-history-add-all-found-2026-11-12.json';
import historyAddNotFound from './test/fixtures/trakt-history-add-not-found-2026-11-12.json';
import historyRemove from './test/fixtures/trakt-history-remove-2026-11-12.json';
import playbackList from './test/fixtures/trakt-playback-2026-11-12.json';
import renewed from './test/fixtures/dmm-trakt-refresh-2026-11-12.json';

const NOW = Date.parse('2026-11-12T12:00:00Z');
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const BUNNY = 'tt1254207';
const SIGHTINGS = 'tt0103558';
const ALITA = 'tt0437086';
const QUEEN = 'tt27668559';
const EPISODE: WatchRef = { imdbId: SIGHTINGS, season: 1, episode: 2 };
const QUEEN_E1: WatchRef = { imdbId: QUEEN, season: 1, episode: 1 };
const iso = (ms: number) => new Date(ms).toISOString();
const ok = (fixture: { status: number; body: unknown }, pageCount?: number): TraktReply => ({ status: fixture.status, data: fixture.body, pageCount });
const STAMPS = { watched: `${activities.movies.watched_at}|${activities.episodes.watched_at}`, paused: `${activities.movies.paused_at}|${activities.episodes.paused_at}` };

const memory = (initial: unknown = null) => {
	let text: string | null = initial === null ? null : JSON.stringify(initial);
	return { read: async () => text, write: async (next: string) => void (text = next) };
};

/** Trakt answering from captured replies by "METHOD path" (no query); a list answers in turn, the last one repeating. */
function fakeTrakt(routes: Record<string, TraktReply | TraktReply[]>) {
	const calls: { method: string; path: string; body?: any; token: string }[] = [];
	const served = new Map<string, number>();
	const trakt = { online: true, calls };
	const http: TraktHttp = async (method, path, token, body) => {
		if (!trakt.online) throw new TypeError('Network request failed');
		calls.push({ method, path, token, body });
		const key = `${method} ${path.split('?')[0]}`;
		const route = routes[key];
		if (!route) return { status: 404, data: null };
		if (!Array.isArray(route)) return route;
		const n = served.get(key) ?? 0;
		served.set(key, n + 1);
		return route[Math.min(n, route.length - 1)];
	};
	return { trakt, http };
}

const IMPORT = {
	'GET /sync/last_activities': { status: 200, data: activities },
	'GET /sync/watched/movies': [ok({ status: 200, body: moviesPage1 }, 2), ok({ status: 200, body: moviesPage2 }, 2)],
	'GET /sync/watched/shows': ok({ status: 200, body: shows }, 1),
	'GET /sync/playback': ok(playbackList),
};

async function setup(routes: Record<string, TraktReply | TraktReply[]>, options: { marks?: WatchStore; state?: unknown; post?: () => Promise<{ status: number; data: any }> } = {}) {
	const account = new TraktAccount({ pull: async () => null, changed: () => undefined }, options.post ?? vi.fn(), memory(), () => NOW);
	await account.connect({ accessToken: 'AT', refreshToken: 'RT', expiresAt: NOW + 7 * DAY, slug: 'dmm-test' });
	const marks = options.marks ?? new WatchStore(memory(), () => NOW);
	const { trakt, http } = fakeTrakt(routes);
	const gaps: number[] = [];
	let now = NOW;
	// 'tb' stands for a provider signed in with the demo key.
	const sync = new TraktSync(account, marks, (provider) => provider === 'tb', memory(options.state ?? null), http, () => now, async (ms) => {
		gaps.push(ms);
		now += ms;
	});
	return { sync, marks, trakt, calls: trakt.calls, gaps, account };
}

describe('scrobbling', () => {
	it('scrobbles a film by its IMDb id and an episode by its show id, season and number; never a file DMM placed nowhere or the demo library', async () => {
		const { sync, calls } = await setup({ 'POST /scrobble/start': { status: 201, data: {} } });
		sync.scrobble({ imdbId: BUNNY, kind: 'movie', provider: 'rd' }, 'start', 1.23456);
		sync.scrobble({ imdbId: SIGHTINGS, kind: 'tv', season: 1, episode: 2, provider: 'ad' }, 'start', 10);
		sync.scrobble({ imdbId: SIGHTINGS, kind: 'tv' }, 'start', 10);
		sync.scrobble({ imdbId: BUNNY, kind: 'movie', provider: 'tb' }, 'start', 10);
		sync.scrobble({ kind: 'movie' }, 'start', 10);
		await sync.settled();
		expect(calls.map(({ path, body, token }) => [path, body, token])).toEqual([
			['/scrobble/start', { movie: { ids: { imdb: BUNNY } }, progress: 1.23 }, 'AT'],
			['/scrobble/start', { show: { ids: { imdb: SIGHTINGS } }, episode: { season: 1, number: 2 }, progress: 10 }, 'AT'],
		]);
	});

	it("uses Trakt's line (80%): a stop before it goes as a pause, a pause from it as a stop; Trakt's mark settles the one made here", async () => {
		const marks = new WatchStore(memory(), () => NOW);
		// What the player's save at 80% does before it reports the stop.
		await marks.set([EPISODE], true);
		const { sync, calls } = await setup({ 'POST /scrobble/stop': ok(stopEpisode), 'POST /scrobble/pause': ok(pauseMovie) }, { marks });
		sync.scrobble({ imdbId: BUNNY, kind: 'movie' }, 'stop', 79.9);
		sync.scrobble({ ...EPISODE, kind: 'tv' }, 'pause', 80);
		await sync.settled();
		expect(calls.map(({ path, body }) => [path, body.progress])).toEqual([['/scrobble/pause', 79.9], ['/scrobble/stop', 80]]);
		expect(marks.pending()).toEqual([]);
		expect(marks.watchedAt(EPISODE)).toBe(NOW);
		// The pause is this device's resume point on Trakt now.
		expect(sync.resumeFor({ imdbId: BUNNY })).toMatchObject({ progress: 79.9, id: pauseMovie.body.id });
	});

	it('takes "409, just scrobbled" as done, and drops the resume point when playback starts again', async () => {
		const marks = new WatchStore(memory(), () => NOW);
		await marks.set([EPISODE], true);
		const { sync } = await setup({ 'POST /scrobble/stop': ok(stopAgain), 'POST /scrobble/pause': ok(pauseMovie), 'POST /scrobble/start': { status: 201, data: {} } }, { marks });
		sync.scrobble({ ...EPISODE, kind: 'tv' }, 'stop', 99);
		sync.scrobble({ imdbId: BUNNY, kind: 'movie' }, 'pause', 41.5);
		await sync.settled();
		expect(marks.pending()).toEqual([]);
		expect(sync.resumeFor({ imdbId: BUNNY })).toBeDefined();
		sync.scrobble({ imdbId: BUNNY, kind: 'movie' }, 'start', 41.5);
		await sync.settled();
		expect(sync.resumeFor({ imdbId: BUNNY })).toBeUndefined();
	});

	it('sends one write a second and waits as long as a 429 asks', async () => {
		const { sync, calls, gaps } = await setup({ 'POST /scrobble/start': [{ status: 429, data: null, retryAfter: 3 }, { status: 201, data: {} }] });
		sync.scrobble({ imdbId: BUNNY, kind: 'movie' }, 'start', 5);
		sync.scrobble({ imdbId: BUNNY, kind: 'movie' }, 'start', 6);
		await sync.settled();
		expect(calls).toHaveLength(3);
		expect(gaps).toEqual([3000, 1000]);
	});

	it('renews a token Trakt refuses (401) and tries once more', async () => {
		const post = vi.fn(async () => ({ status: renewed.status, data: renewed.body }));
		const { sync, calls } = await setup({ 'POST /scrobble/start': [{ status: 401, data: null }, { status: 201, data: {} }] }, { post });
		sync.scrobble({ imdbId: BUNNY, kind: 'movie' }, 'start', 5);
		await sync.settled();
		expect(calls.map((call) => call.token)).toEqual(['AT', renewed.body.accessToken]);
		expect(post).toHaveBeenCalledTimes(1);
	});

	it('keeps what could not be sent offline: a finished stop as a dated history mark, a pause to send again', async () => {
		const marks = new WatchStore(memory(), () => NOW);
		await marks.set([EPISODE], true, NOW - 5 * MIN);
		const { sync, trakt, calls } = await setup(
			{ ...IMPORT, 'POST /scrobble/stop': ok(stopEpisode), 'POST /scrobble/pause': ok(pauseMovie), 'POST /sync/history': ok(historyAdd) },
			{ marks, state: { joined: true, ...STAMPS, playback: {}, unsent: {}, drops: [] } }
		);
		trakt.online = false;
		sync.scrobble({ ...EPISODE, kind: 'tv' }, 'stop', 96);
		sync.scrobble({ imdbId: BUNNY, kind: 'movie' }, 'pause', 41.5);
		await sync.settled();
		expect(marks.pending()).toHaveLength(1);

		trakt.online = true;
		await sync.sync(true);
		expect(calls.find((call) => call.path === '/sync/history')!.body).toEqual({
			movies: [],
			shows: [{ ids: { imdb: SIGHTINGS }, seasons: [{ number: 1, episodes: [{ number: 2, watched_at: iso(NOW - 5 * MIN) }] }] }],
		});
		expect(calls.find((call) => call.path === '/scrobble/pause')!.body).toEqual({ movie: { ids: { imdb: BUNNY } }, progress: 41.5 });
		expect(marks.pending()).toEqual([]);
		// last_activities did not move: the history is not downloaded again.
		expect(calls.some((call) => call.path.startsWith('/sync/watched'))).toBe(false);
	});
});

describe('watched history', () => {
	it("joins this device's history with Trakt's the first time (Trakt's answers of 2026-11-09: two pages of films, shows by season)", async () => {
		const marks = new WatchStore(memory(), () => NOW);
		await marks.set([{ imdbId: BUNNY }], true, NOW - DAY);
		await marks.set([{ imdbId: ALITA }], true, NOW - DAY);
		// Unwatched here before Trakt was connected: Trakt's history keeps it.
		await marks.set([QUEEN_E1], true, NOW - 2 * DAY);
		await marks.set([QUEEN_E1], false, NOW - DAY);
		const { sync, calls } = await setup({ ...IMPORT, 'POST /sync/history': ok(historyAdd) }, { marks });
		await sync.sync(true);

		expect(calls.filter((call) => call.method === 'GET').map((call) => call.path)).toEqual([
			'/sync/last_activities',
			'/sync/watched/movies?page=1&limit=250',
			'/sync/watched/movies?page=2&limit=250',
			'/sync/watched/shows?extended=progress&page=1&limit=250',
			'/sync/playback',
		]);
		expect(marks.watchedAt({ imdbId: ALITA })).toBe(Date.parse('2025-04-13T12:20:00.000Z'));
		expect(marks.watchedAt(QUEEN_E1)).toBe(Date.parse('2026-01-16T21:30:00.000Z'));
		// 6 films and 91 episodes from Trakt, and the one film only this device had.
		expect(marks.list()).toHaveLength(6 + 91 + 1);
		// Only what Trakt lacked was sent; Alita was not played twice.
		expect(calls.filter((call) => call.method === 'POST').map((call) => [call.path, call.body])).toEqual([
			['/sync/history', { movies: [{ ids: { imdb: BUNNY }, watched_at: iso(NOW - DAY) }], shows: [] }],
		]);
		expect(marks.pending()).toEqual([]);
	});

	it('later imports take what was unwatched on Trakt, keep changes not sent yet and episodes Trakt does not know', async () => {
		const marks = new WatchStore(memory(), () => NOW);
		// An earlier import listed these.
		await marks.merge(watchedFromTrakt([...moviesPage1, ...moviesPage2], shows), true);
		await marks.set([QUEEN_E1], false, NOW - MIN);
		// tt0103558 is "Sterne des Südens" on Trakt, three episodes long: S01E04 does not exist there (live, 2026-11-12).
		const UNKNOWN = { imdbId: SIGHTINGS, season: 1, episode: 4 };
		await marks.set([UNKNOWN], true, NOW - MIN);
		const { sync, calls } = await setup(
			{
				...IMPORT,
				// Alita was unwatched on Trakt meanwhile.
				'GET /sync/watched/movies': ok({ status: 200, body: moviesPage2 }, 1),
				// Trakt's answer to exactly this: S01E04 alone, added 0.
				'POST /sync/history': ok(historyAddNotFound),
				'POST /sync/history/remove': [{ status: 503, data: null }, ok(historyRemove)],
			},
			{ marks, state: { joined: true, watched: 'older', paused: STAMPS.paused, playback: {}, unsent: {}, drops: [] } }
		);
		await sync.sync(true);
		expect(marks.watchedAt({ imdbId: ALITA })).toBeUndefined();
		// The removal did not get through (503): still unwatched here, still to send, though Trakt listed it.
		expect(marks.watchedAt(QUEEN_E1)).toBeUndefined();
		expect(marks.pending()).toEqual([expect.objectContaining({ ...QUEEN_E1, removed: true })]);
		// Sent, never listed by Trakt (its not_found echoes every episode of the show, so it cannot tell): kept here.
		expect(marks.watchedAt(UNKNOWN)).toBe(NOW - MIN);
		expect(marks.pending().some((entry) => entry.episode === 4)).toBe(false);

		await sync.sync(true);
		expect(calls.filter((call) => call.path === '/sync/history/remove').at(-1)!.body).toEqual({ movies: [], shows: [{ ids: { imdb: QUEEN }, seasons: [{ number: 1, episodes: [{ number: 1 }] }] }] });
		expect(marks.pending()).toEqual([]);
		expect(marks.watchedAt(QUEEN_E1)).toBeUndefined();
	});

	// Pixel 6, 2026-11-12: The Civil War S01 marked on the phone, S01E05 then unwatched on Trakt before the phone read
	// Trakt again; the phone kept S01E05 watched for good, as an episode Trakt did not know.
	it('takes an unwatch made on Trakt for a mark sent from here before any import confirmed it', async () => {
		const marks = new WatchStore(memory(), () => NOW);
		const CIVIL_E5 = { imdbId: 'tt0098769', season: 1, episode: 5 };
		const { sync } = await setup({ ...IMPORT, 'POST /sync/history': ok(historyAddAll) }, { marks, state: { joined: true, watched: 'older', paused: STAMPS.paused, playback: {}, unsent: {}, drops: [] } });
		await marks.set([CIVIL_E5], true, NOW - MIN);
		await sync.sync(true);
		// Trakt's history (the captured lists) lacks S01E05: it was unwatched there after it went.
		expect(marks.watchedAt(CIVIL_E5)).toBeUndefined();
	});

	it('sends no second play when a season is marked again over episodes already watched', async () => {
		const marks = new WatchStore(memory(), () => NOW);
		await marks.merge(watchedFromTrakt([], shows), true);
		const season = [1, 2, 3].map((episode) => ({ imdbId: QUEEN, season: 1, episode }));
		await marks.set(season, true, NOW);
		expect(marks.pending()).toEqual([]);
		// Its time moves, so Next Up follows the latest mark.
		expect(marks.watchedAt(QUEEN_E1)).toBe(NOW);
		// Unmarked and marked again before Trakt heard: still one change to send.
		await marks.set([QUEEN_E1], false, NOW);
		await marks.set([QUEEN_E1], true, NOW + 1);
		expect(marks.pending()).toEqual([{ ...QUEEN_E1, watchedAt: NOW + 1, pending: true }]);
	});

	it('reads films and episodes by IMDb id from the real answers, leaving out what has none', () => {
		const found = watchedFromTrakt([...moviesPage1, ...moviesPage2, { movie: { ids: { imdb: null } }, last_watched_at: '2026-01-01T00:00:00.000Z' }], shows);
		expect(found.get(watchKey(QUEEN_E1))).toEqual({ ...QUEEN_E1, watchedAt: Date.parse('2026-01-16T21:30:00.000Z') });
		expect(found.size).toBe(6 + 91);
	});

	// Ben's iPhone, 2026-11-12: signing in adopted DMM web's Trakt login, and Continue Watching stayed empty until the next start.
	it('reads Trakt as soon as a login arrives, not at the next start', async () => {
		const account = new TraktAccount({ pull: async () => null, changed: () => undefined }, vi.fn(), memory(), () => NOW);
		const { trakt, http } = fakeTrakt(IMPORT);
		const sync = new TraktSync(account, new WatchStore(memory(), () => NOW), () => false, memory(), http, () => NOW, async () => undefined);
		await account.load();
		expect(trakt.calls).toEqual([]);
		await account.adopt({ 'trakt:accessToken': JSON.stringify({ value: 'AT', expiry: NOW + 7 * DAY }), 'trakt:refreshToken': '"RT"' });
		await vi.waitFor(() => expect(sync.playback()).toHaveLength(2));
		expect(trakt.calls[0].path).toBe('/sync/last_activities');
	});

	it('forgets what it read from Trakt when Trakt is disconnected, keeping the watched marks', async () => {
		const { sync, marks, account } = await setup({ ...IMPORT, 'POST /sync/history': ok(historyAdd) });
		await sync.sync(true);
		expect(sync.playback()).toHaveLength(2);
		await account.disconnect();
		await sync.settled();
		expect(sync.playback()).toEqual([]);
		expect(marks.watchedAt(QUEEN_E1)).toBeDefined();
	});
});

describe('resume points from other devices', () => {
	const points = playbackFromTrakt(playbackList.body);
	const movie = points[BUNNY];
	const saved = (fraction: number, updatedAt: number): PlaybackEntry => ({ position: fraction * 90 * MIN, duration: 90 * MIN, finished: false, updatedAt, name: 'bbb.mp4', imdbId: BUNNY, kind: 'movie' });

	it('reads /sync/playback by film and by episode', () => {
		expect(Object.keys(points)).toEqual([`${SIGHTINGS}:1:3`, BUNNY]);
		expect(movie).toEqual({ imdbId: BUNNY, progress: 79.9, pausedAt: Date.parse(playbackList.body[1].paused_at), id: pauseMovie.body.id });
		expect(points[`${SIGHTINGS}:1:3`]).toMatchObject({ season: 1, episode: 3, progress: 40 });
	});

	it("offers another device's newer pause, not this device's own pause coming back from Trakt", () => {
		expect(otherDevice(movie, undefined)).toBe(true);
		expect(otherDevice(movie, saved(0.799, movie.pausedAt - 2000))).toBe(false);
		expect(otherDevice(movie, saved(0.1, movie.pausedAt - 2 * 3600_000))).toBe(true);
		expect(otherDevice(movie, saved(0.1, movie.pausedAt + 5 * MIN))).toBe(false);
		expect(otherDevice({ ...movie, progress: 95 }, undefined)).toBe(false);
	});

	it('lists only titles the library holds, not watched since, the newest per title', () => {
		const all = Object.values(points);
		expect(remoteResumes([], all, (imdbId) => imdbId === SIGHTINGS, () => undefined).map(watchKey)).toEqual([`${SIGHTINGS}:1:3`]);
		expect(remoteResumes([], all, () => true, (ref) => (ref.imdbId === SIGHTINGS ? Date.parse(playbackList.body[0].paused_at) + MIN : undefined)).map(watchKey)).toEqual([BUNNY]);
		// Played here since: this device's own playback wins for the film.
		expect(remoteResumes([['k', saved(0.2, movie.pausedAt + 5 * MIN)]], all, () => true, () => undefined).map(watchKey)).toEqual([`${SIGHTINGS}:1:3`]);
		// Newest first.
		expect(remoteResumes([], all, () => true, () => undefined).map(watchKey)).toEqual([`${SIGHTINGS}:1:3`, BUNNY]);
	});
});
