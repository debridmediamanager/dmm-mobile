import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-secure-store', () => ({ getItemAsync: vi.fn(async () => null), setItemAsync: vi.fn(), deleteItemAsync: vi.fn() }));
vi.mock('expo-file-system', () => ({ File: class {}, Paths: {} }));

import { pollSimklLink, SimklAccount, simklHttp, startSimklLink } from './simkl';
import { SIMKL, simklTook, watchedFromSimkl } from './simklSync';
import { playbackFromTrakt, TrackerSync, type TraktHttp, type TraktReply } from './trackerSync';
import { TraktAccount } from './trakt';
import { WatchStore, watchKey, type WatchRef } from './watched';
import device from './test/fixtures/simkl-device-2026-11-12.json';
import pending from './test/fixtures/simkl-poll-pending-2026-11-12.json';
import slowDown from './test/fixtures/simkl-poll-slow-down-2026-11-12.json';
import expired from './test/fixtures/simkl-poll-expired-2026-11-12.json';
import tokenWrite from './test/fixtures/simkl-token-write-2026-11-12.json';
import refreshReadOnly from './test/fixtures/simkl-refresh-read-only-2026-11-12.json';
import invalidGrant from './test/fixtures/simkl-refresh-invalid-grant-2026-11-12.json';
import settings from './test/fixtures/simkl-users-settings-2026-11-12.json';
import startReadOnly from './test/fixtures/simkl-scrobble-start-read-only-2026-11-12.json';
import pause85 from './test/fixtures/simkl-scrobble-pause-85-2026-11-12.json';
import stop79 from './test/fixtures/simkl-scrobble-stop-79-2026-11-12.json';
import stop80 from './test/fixtures/simkl-scrobble-stop-80-2026-11-12.json';
import stop409 from './test/fixtures/simkl-scrobble-stop-409-2026-11-12.json';
import historyAdd from './test/fixtures/simkl-history-add-2026-11-12.json';
import historyAddAgain from './test/fixtures/simkl-history-add-again-2026-11-12.json';
import historyUnknownEpisodes from './test/fixtures/simkl-history-add-unknown-episodes-2026-11-12.json';
import historyRemove from './test/fixtures/simkl-history-remove-2026-11-12.json';
import pauseMovie from './test/fixtures/simkl-scrobble-pause-movie-2026-11-12.json';
import startUnknown from './test/fixtures/simkl-scrobble-start-unknown-2026-11-12.json';
import stopAnime from './test/fixtures/simkl-scrobble-stop-anime-2026-11-12.json';
import activities from './test/fixtures/simkl-activities-2026-11-12.json';
import allItems from './test/fixtures/simkl-all-items-2026-11-12.json';
import playbackList from './test/fixtures/simkl-playback-2026-11-12.json';
import traktActivities from './test/fixtures/trakt-last-activities-2026-11-09.json';
import traktHistoryAddAll from './test/fixtures/trakt-history-add-all-found-2026-11-12.json';
import traktHistoryRemove from './test/fixtures/trakt-history-remove-2026-11-12.json';

const NOW = Date.parse('2026-11-12T19:00:00Z');
const DAY = 24 * 3600_000;
const SINTEL = 'tt1727587';
const WEEDS = 'tt0439100';
const MHA = 'tt5626028';
const CHERNOBYL = 'tt7366338';
const YOUR_NAME = 'tt5311514';
const reply = (fixture: { status: number; body: unknown }): TraktReply => ({ status: fixture.status, data: fixture.body });
const memory = (initial: unknown = null) => {
	let text: string | null = initial === null ? null : JSON.stringify(initial);
	return { read: async () => text, write: async (next: string) => void (text = next) };
};
const login = (scope = 'media:read media:write') => ({ accessToken: 'AT', refreshToken: 'RT', expiresAt: NOW + 7 * DAY, scope, name: 'DMM Mobile Test' });

/** A tracker answering from captured replies by "METHOD path" (no query); a list answers in turn, the last one repeating. */
function fake(routes: Record<string, TraktReply | TraktReply[]>) {
	const calls: { method: string; path: string; body?: any }[] = [];
	const served = new Map<string, number>();
	const http: TraktHttp = async (method, path, _token, body) => {
		calls.push({ method, path, body });
		const key = `${method} ${path.split('?')[0]}`;
		const route = routes[key];
		if (!route) return { status: 404, data: null };
		if (!Array.isArray(route)) return route;
		const n = served.get(key) ?? 0;
		served.set(key, n + 1);
		return route[Math.min(n, route.length - 1)];
	};
	return { calls, http };
}

async function simklSync(routes: Record<string, TraktReply | TraktReply[]>, options: { marks?: WatchStore; scope?: string; state?: unknown } = {}) {
	const account = new SimklAccount(vi.fn(), memory(), () => NOW);
	await account.connect(login(options.scope));
	const marks = options.marks ?? new WatchStore(memory(), () => NOW);
	const { calls, http } = fake(routes);
	const gaps: number[] = [];
	const sync = new TrackerSync(account, marks, (provider) => provider === 'tb', memory(options.state ?? null), http, () => NOW, async (ms) => void gaps.push(ms), SIMKL);
	return { sync, marks, calls, gaps, account };
}

const SIMKL_IMPORT = { 'GET /sync/activities': reply(activities), 'GET /sync/all-items': reply(allItems), 'GET /sync/playback': reply(playbackList) };

describe('linking Simkl (device code, live answers 2026-11-12)', () => {
	it('asks for write access and shows the code, its page and the pre-filled link', async () => {
		const call = vi.fn(async () => reply(device));
		const link = await startSimklLink(call);
		expect(call).toHaveBeenCalledWith('POST', '/oauth2/device', expect.objectContaining({ scope: 'media:read media:write' }));
		expect(link).toEqual({ userCode: device.body.user_code, deviceCode: 'DEVICECODE', verifyUrl: device.body.verification_uri_complete, page: 'simkl.com/pin', interval: 5, expiresIn: 900 });
	});

	it('polls: waiting, slow down, expired, then the login with its scope and who approved', async () => {
		expect(await pollSimklLink('D', async () => reply(pending))).toBe('pending');
		expect(await pollSimklLink('D', async () => reply(slowDown))).toBe('slow_down');
		expect(await pollSimklLink('D', async () => reply(expired))).toBe('expired');
		const call = vi.fn(async (_method: string, path: string) => reply(path === '/users/settings' ? settings : tokenWrite));
		expect(await pollSimklLink('D', call, NOW)).toEqual({ accessToken: 'simkl_at_ACCESSTOKEN', refreshToken: 'simkl_rt_REFRESHTOKEN', expiresAt: NOW + 7 * DAY, scope: 'media:read media:write', name: 'DMM Mobile Test' });
	});

	it('renews in the last hour with the same refresh token, and asks to connect again once Simkl refuses the grant', async () => {
		const call = vi.fn(async () => reply(refreshReadOnly));
		let now = NOW;
		const account = new SimklAccount(call, memory(), () => now);
		await account.connect(login());
		expect(await account.token()).toBe('AT');
		now = NOW + 7 * DAY - 30 * 60_000;
		expect(await account.token()).toBe('simkl_at_ACCESSTOKEN');
		expect(call).toHaveBeenCalledWith('POST', '/oauth2/token', expect.objectContaining({ grant_type: 'refresh_token', refresh_token: 'RT' }));
		expect(account.login?.name).toBe('DMM Mobile Test');
		call.mockResolvedValueOnce(reply(invalidGrant));
		expect(await account.token(true)).toBeNull();
		expect(account.refused).toBe(true);
	});

	it('takes a read-only grant (DMM\'s Kodi link asks for media:read) as read-only', async () => {
		const account = new SimklAccount(vi.fn(), memory(), () => NOW);
		await account.connect({ ...login(), scope: refreshReadOnly.body.scope });
		expect(account.readOnly).toBe(true);
		await account.connect(login(tokenWrite.body.scope));
		expect(account.readOnly).toBe(false);
	});
});

describe("Simkl's answers", () => {
	it('reads the watched history: films once completed, every episode, anime by its IMDb-style season, an anime film as a film', () => {
		const found = watchedFromSimkl(allItems.body);
		expect(found.get(SINTEL)).toEqual({ imdbId: SINTEL, watchedAt: Date.parse('2026-11-12T18:01:25Z') });
		expect(found.get(YOUR_NAME)).toEqual({ imdbId: YOUR_NAME, watchedAt: Date.parse('2026-11-09T20:00:00Z') });
		// Simkl numbers My Hero Academia's 2019 cour from 1: its E14 is the show's S04E14.
		expect(found.get(watchKey({ imdbId: MHA, season: 4, episode: 14 }))).toBeDefined();
		expect(found.has(watchKey({ imdbId: MHA, season: 1, episode: 14 }))).toBe(false);
		// A show marked complete in one go comes with all its episodes.
		expect([...found.keys()].filter((key) => key.startsWith(`${CHERNOBYL}:1:`))).toHaveLength(5);
		expect([...found.keys()].filter((key) => key.startsWith(`${WEEDS}:`))).toHaveLength(13);
		expect(found.size).toBe(1 + 1 + 1 + 5 + 13);
	});

	it('knows exactly which films and episodes Simkl did not take', () => {
		const took = simklTook(reply(historyUnknownEpisodes));
		expect(took({ imdbId: WEEDS, season: 1, episode: 5, watchedAt: 1 })).toBe(true);
		expect(took({ imdbId: WEEDS, season: 1, episode: 99, watchedAt: 1 })).toBe(false);
		expect(took({ imdbId: WEEDS, season: 42, episode: 1, watchedAt: 1 })).toBe(false);
		const add = simklTook(reply(historyAdd));
		expect(add({ imdbId: 'tt2285752', watchedAt: 1 })).toBe(true);
		expect(add({ imdbId: 'tt99999999', watchedAt: 1 })).toBe(false);
		expect(add({ imdbId: 'tt0000001x', season: 1, episode: 1, watchedAt: 1 })).toBe(false);
		// Sent again, Simkl counts nothing added but still holds them: not_found decides, not the count.
		expect(historyAddAgain.body.added.episodes).toBe(0);
		expect(simklTook(reply(historyAddAgain))({ imdbId: MHA, season: 4, episode: 15, watchedAt: 1 })).toBe(true);
	});

	it("reads resume points, an anime episode by its IMDb-style season and number", () => {
		const points = playbackFromTrakt(playbackList.body);
		expect(points[watchKey({ imdbId: MHA, season: 4, episode: 16 })]).toMatchObject({ progress: 33, id: playbackList.body[0].id });
		expect(points[watchKey({ imdbId: WEEDS, season: 1, episode: 2 })]).toMatchObject({ progress: 40 });
	});

	describe('simklHttp', () => {
		afterEach(() => vi.unstubAllGlobals());
		it("names the app on every call and takes a scrobble lock (400 RATE_LIMIT) as a 20-second wait", async () => {
			const fetchMock = vi.fn(async () => new Response('{"error":"RATE_LIMIT","code":400}', { status: 400 }));
			vi.stubGlobal('fetch', fetchMock);
			expect(await simklHttp('POST', '/scrobble/start', 'AT', {})).toMatchObject({ status: 429, retryAfter: 20 });
			const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
			expect(url).toMatch(/^https:\/\/api\.simkl\.com\/scrobble\/start\?client_id=[0-9a-f]{64}&app-name=dmm-mobile&app-version=\d/);
			expect(init.headers).toMatchObject({ authorization: 'Bearer AT', 'user-agent': expect.stringMatching(/^dmm-mobile\//) });
		});
	});
});

describe('Simkl through the tracker sync', () => {
	it("scrobbles on the app's line (80%): a pause there goes as a stop, a stop before it as a pause, 409 is done; no start after a seek", async () => {
		const marks = new WatchStore(memory(), () => NOW);
		await marks.set([{ imdbId: SINTEL }], true);
		const { sync, calls } = await simklSync({ 'POST /scrobble/stop': [reply(stop80), reply(stop409)], 'POST /scrobble/pause': reply(stop79), 'POST /scrobble/start': { status: 201, data: {} } }, { marks });
		sync.scrobble({ imdbId: SINTEL, kind: 'movie', provider: 'rd' }, 'start', 50);
		sync.scrobble({ imdbId: SINTEL, kind: 'movie', provider: 'rd' }, 'start', 60, true);
		sync.scrobble({ imdbId: WEEDS, kind: 'tv', season: 1, episode: 2 }, 'stop', 79.9);
		sync.scrobble({ imdbId: SINTEL, kind: 'movie' }, 'pause', 85);
		sync.scrobble({ imdbId: SINTEL, kind: 'movie' }, 'stop', 95);
		sync.scrobble({ imdbId: SINTEL, kind: 'movie', provider: 'tb' }, 'start', 1);
		await sync.settled();
		expect(calls.map(({ path, body }) => [path, body.progress])).toEqual([['/scrobble/start', 50], ['/scrobble/pause', 79.9], ['/scrobble/stop', 85], ['/scrobble/stop', 95]]);
		// Simkl took the stop: the mark made here is on Simkl, still to send to Trakt.
		expect(marks.pending('simkl')).toEqual([]);
		expect(marks.pending('trakt')).toHaveLength(1);
		// Simkl keeps a pause past 80% as a resume point (live); the app sends a stop there, so it is watched on both sides.
		expect(pause85.body.action).toBe('pause');
		expect(stop80.body.action).toBe('scrobble');
	});

	it("keeps a pause as this device's resume point, sends anime by the show's IMDb id and season, and lets an unknown title be", async () => {
		const marks = new WatchStore(memory(), () => NOW);
		const MHA_E14: WatchRef = { imdbId: MHA, season: 4, episode: 14 };
		await marks.set([MHA_E14], true);
		const { sync, calls } = await simklSync({ 'POST /scrobble/pause': reply(pauseMovie), 'POST /scrobble/stop': reply(stopAnime), 'POST /scrobble/start': reply(startUnknown) }, { marks });
		sync.scrobble({ imdbId: SINTEL, kind: 'movie' }, 'pause', 12.34);
		sync.scrobble({ ...MHA_E14, kind: 'tv' }, 'stop', 90);
		sync.scrobble({ imdbId: 'tt99999999', kind: 'movie' }, 'start', 1);
		await sync.settled();
		expect(sync.resumeFor({ imdbId: SINTEL })).toMatchObject({ progress: 12.34, id: pauseMovie.body.id });
		expect(calls[1].body).toEqual({ show: { ids: { imdb: MHA } }, episode: { season: 4, number: 14 }, progress: 90 });
		// Simkl filed it under its 2019 anime entry as E14, with the show's numbering beside it.
		expect(stopAnime.body.episode).toMatchObject({ season: 1, number: 14, tvdb_season: 4, tvdb_number: 14 });
		expect(marks.pending('simkl')).toEqual([]);
		expect(sync.error).toBe('');
	});

	it('sends nothing with a read-only grant, and still reads the history', async () => {
		const { sync, calls, marks } = await simklSync({ ...SIMKL_IMPORT, 'POST /scrobble/start': reply(startReadOnly) }, { scope: 'media:read' });
		await marks.set([{ imdbId: 'tt2285752' }], true);
		sync.scrobble({ imdbId: SINTEL, kind: 'movie' }, 'start', 5);
		await sync.sync(true);
		expect(calls.filter((call) => call.method === 'POST')).toEqual([]);
		expect(marks.watchedAt({ imdbId: SINTEL })).toBeDefined();
	});

	it('stops calling when the daily allowance is used up and keeps what waits for later', async () => {
		const marks = new WatchStore(memory(), () => NOW);
		await marks.set([{ imdbId: SINTEL }], true);
		const { sync, calls, gaps } = await simklSync({ 'POST /scrobble/stop': { status: 429, data: null, retryAfter: 5 * 3600 } }, { marks });
		sync.scrobble({ imdbId: SINTEL, kind: 'movie' }, 'stop', 90);
		sync.scrobble({ imdbId: SINTEL, kind: 'movie' }, 'stop', 91);
		await sync.settled();
		expect(gaps).toEqual([]);
		expect(calls).toHaveLength(1);
		expect(marks.pending('simkl')).toHaveLength(1);
		expect(sync.error).toMatch(/no more requests today/);
	});

	it('reads the history only when an activity stamp moved', async () => {
		const stamps = SIMKL.stamps(activities.body);
		const { sync, calls } = await simklSync(SIMKL_IMPORT, { state: { joined: true, ...stamps, playback: {}, unsent: {}, drops: [] } });
		await sync.sync(true);
		expect(calls.map((call) => call.path)).toEqual(['/sync/activities']);
	});
});

describe('Trakt and Simkl together', () => {
	const TRAKT_SHOW = { imdbId: 'tt27668559', season: 1, episode: 1 };
	async function both() {
		const marks = new WatchStore(memory(), () => NOW);
		const trakt = new TraktAccount({ pull: async () => null, changed: () => undefined }, vi.fn(), memory(), () => NOW);
		await trakt.connect({ accessToken: 'AT', refreshToken: 'RT', expiresAt: NOW + 7 * DAY });
		const traktFake = fake({
			'GET /sync/last_activities': { status: 200, data: traktActivities },
			'GET /sync/watched/movies': { status: 200, data: [], pageCount: 1 },
			'GET /sync/watched/shows': { status: 200, data: [{ show: { ids: { imdb: TRAKT_SHOW.imdbId } }, seasons: [{ number: 1, episodes: [{ number: 1, last_watched_at: '2026-01-16T21:30:00.000Z' }] }] }], pageCount: 1 },
			'GET /sync/playback': { status: 200, data: [] },
			'POST /sync/history': reply(traktHistoryAddAll),
			'POST /sync/history/remove': reply(traktHistoryRemove),
		});
		const traktSync = new TrackerSync(trakt, marks, () => false, memory(), traktFake.http, () => NOW, async () => undefined);
		const simkl = await simklSync({ ...SIMKL_IMPORT, 'POST /sync/history': reply(historyAddAgain), 'POST /sync/history/remove': reply(historyRemove) }, { marks });
		await traktSync.sync(true);
		await simkl.sync.sync(true);
		return { marks, traktSync, traktFake, simkl };
	}

	it('shows what either one lists, and sends neither the other one\'s history', async () => {
		const { marks, traktFake, simkl } = await both();
		expect(marks.watchedAt(TRAKT_SHOW)).toBeDefined();
		expect(marks.watchedAt({ imdbId: SINTEL })).toBeDefined();
		expect(marks.list()).toHaveLength(1 + 21);
		expect(traktFake.calls.filter((call) => call.method === 'POST')).toEqual([]);
		expect(simkl.calls.filter((call) => call.method === 'POST')).toEqual([]);
	});

	it('sends a mark made here to both, each settling its own', async () => {
		const { marks, traktSync, traktFake, simkl } = await both();
		const episode: WatchRef = { imdbId: WEEDS, season: 1, episode: 4 };
		await marks.set([episode], true, NOW - 60_000);
		await traktSync.sync(true);
		await simkl.sync.sync(true);
		const sent = (calls: { path: string; body?: any }[]) => calls.filter((call) => call.path === '/sync/history').map((call) => call.body);
		const body = { movies: [], shows: [{ ids: { imdb: WEEDS }, seasons: [{ number: 1, episodes: [{ number: 4, watched_at: new Date(NOW - 60_000).toISOString() }] }] }] };
		expect(sent(traktFake.calls)).toEqual([body]);
		expect(sent(simkl.calls)).toEqual([body]);
		expect(marks.pending('trakt')).toEqual([]);
		expect(marks.pending('simkl')).toEqual([]);
	});

	it('sends an unmark made here to both, and forgets it once both have it', async () => {
		const { marks, traktSync, traktFake, simkl } = await both();
		traktFake.calls.length = 0;
		const episode: WatchRef = { imdbId: WEEDS, season: 1, episode: 3 };
		await marks.set([episode], false, NOW);
		simkl.calls.length = 0;
		await simkl.sync.sync(true);
		expect(marks.pending('simkl')).toEqual([]);
		// Trakt has not heard yet: the removal waits for it.
		expect(marks.pending('trakt')).toEqual([expect.objectContaining({ ...episode, removed: true })]);
		void traktSync.sync(true);
		await traktSync.settled();
		const removal = { movies: [], shows: [{ ids: { imdb: WEEDS }, seasons: [{ number: 1, episodes: [{ number: 3 }] }] }] };
		expect(simkl.calls.find((call) => call.path === '/sync/history/remove')!.body).toEqual(removal);
		expect(traktFake.calls.find((call) => call.path === '/sync/history/remove')!.body).toEqual(removal);
		expect(marks.pending('trakt')).toEqual([]);
		expect(marks.watchedAt(episode)).toBeUndefined();
	});

	it("keeps a title one tracker still lists after the other unwatched it, and drops it once neither does", async () => {
		const { marks } = await both();
		// Sintel goes to Trakt as well, so both list it.
		await marks.set([{ imdbId: SINTEL }], false, NOW - 1000);
		await marks.set([{ imdbId: SINTEL }], true, NOW - 500);
		await marks.settle([{ imdbId: SINTEL, watchedAt: NOW - 500 }], 'trakt', true);
		await marks.settle([{ imdbId: SINTEL, watchedAt: NOW - 500 }], 'simkl', true);
		// Unwatched on Simkl: its next answer lacks Sintel and Chernobyl.
		const without = { ...allItems.body, movies: [], shows: allItems.body.shows.filter((row) => row.show.ids.imdb !== CHERNOBYL) };
		await marks.merge(watchedFromSimkl(without), 'simkl', false);
		expect(marks.watchedAt({ imdbId: SINTEL })).toBe(NOW - 500);
		expect(marks.watchedAt({ imdbId: CHERNOBYL, season: 1, episode: 1 })).toBeUndefined();
	});
});
