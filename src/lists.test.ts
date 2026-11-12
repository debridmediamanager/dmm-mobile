import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-secure-store', () => ({ getItemAsync: vi.fn(async () => null), setItemAsync: vi.fn(), deleteItemAsync: vi.fn() }));
vi.mock('expo-file-system', () => ({ File: class {}, Paths: {} }));

import { simklLists, traktEntries, watchlist, type TrackerList } from './lists';
import type { LibraryItem } from './model';
import { SimklAccount } from './simkl';
import { SIMKL } from './simklSync';
import { groupTitles, identificationKey, type Identification } from './titles';
import { TRAKT, TrackerSync, type TraktHttp, type TraktReply } from './trackerSync';
import { TraktAccount } from './trakt';
import { WatchStore } from './watched';
import traktActivities from './test/fixtures/trakt-last-activities-lists-2026-11-12.json';
import traktWatchlist from './test/fixtures/trakt-watchlist-2026-11-12.json';
import traktOwn from './test/fixtures/trakt-my-lists-2026-11-12.json';
import traktLiked from './test/fixtures/trakt-liked-lists-2026-11-12.json';
import traktOwnItems from './test/fixtures/trakt-list-items-own-2026-11-12.json';
import traktLikedItems from './test/fixtures/trakt-list-items-liked-2026-11-12.json';
import simklActivities from './test/fixtures/simkl-activities-lists-2026-11-12.json';
import simklAllItems from './test/fixtures/simkl-all-items-lists-2026-11-12.json';
import identifyFixture from './test/fixtures/dmm-identify-testacct123-2026-11-12.json';
import fireTv from './test/fixtures/firetv-playback-civil-war-2026-11-12.json';

const NOW = Date.parse('2026-11-12T20:00:00Z');
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const BUNNY = 'tt1254207';
const SHAWSHANK = 'tt0111161';
const BREAKING_BAD = 'tt0903747';
const CIVIL_WAR = 'tt0098769';
const BIRDS_OF_PREY = 'tt7713068';
const WEEDS = 'tt0439100';
const MHA = 'tt5626028';
const YOUR_NAME = 'tt5311514';
const OWN_LIST = '38132493';
const LIKED_LIST = '36987891';
const ok = (fixture: { status: number; body: unknown; pageCount?: number }): TraktReply => ({ status: fixture.status, data: fixture.body, pageCount: fixture.pageCount });
const memory = (initial: unknown = null) => {
	let text: string | null = initial === null ? null : JSON.stringify(initial);
	return { read: async () => text, write: async (next: string) => void (text = next) };
};

/** A tracker answering from captured replies by "METHOD path" (no query). */
function fake(routes: Record<string, TraktReply>) {
	const calls: string[] = [];
	const http: TraktHttp = async (method, path) => {
		calls.push(path);
		return routes[`${method} ${path.split('?')[0]}`] ?? { status: 404, data: null };
	};
	return { calls, http };
}

/**
 * The library as the app names it: testacct123's releases with DMM's answers (Weeds, My Hero Academia among them),
 * and the Fire TV's (rd6893c80a7036) The Civil War and Birds of Prey with the ids the app gave them.
 */
const row = (id: string, filename: string, hash: string): LibraryItem => ({ id, provider: 'rd', title: filename, filename, hash, size: 1, progress: 100, status: 'finished', serviceStatus: 'downloaded', added: '2026-11-01T00:00:00Z', files: [] });
const answers = new Map<string, Identification | null>(identifyFixture.items.map((entry, n) => [identificationKey(entry), identifyFixture.identify.results[n] as Identification | null]));
answers.set(identificationKey(fireTv.releases[0]), { imdbId: CIVIL_WAR, title: 'The Civil War', year: 1990, kind: 'tv' });
answers.set(identificationKey(fireTv.releases[1]), { imdbId: BIRDS_OF_PREY, title: 'Birds of Prey', year: 2020, kind: 'movie' });
const library = groupTitles([...identifyFixture.items, ...fireTv.releases].map((entry, n) => row(`rd:${n}`, entry.filename, entry.hash)), (item) => answers.get(identificationKey(item)));
const held = new Set(library.titles.map((title) => title.imdbId));
const inLibrary = (imdbId: string) => held.has(imdbId);

const traktLists = (): TrackerList[] => [
	{ id: 'watchlist', name: 'Watchlist', kind: 'watchlist', items: traktEntries(traktWatchlist.body) },
	{ id: OWN_LIST, name: 'DMM Mobile test', kind: 'own', items: traktEntries(traktOwnItems.body) },
	{ id: LIKED_LIST, name: 'Citadel Movies', kind: 'liked', items: traktEntries(traktLikedItems.body) },
];

describe('reading the lists (Trakt and Simkl test accounts, 2026-11-12)', () => {
	it("keeps Trakt's order, films and shows by IMDb id, with the year when Trakt has one", () => {
		expect(traktEntries(traktWatchlist.body)).toEqual([
			{ imdbId: BUNNY, kind: 'movie', title: 'Big Buck Bunny', year: 2008, added: Date.parse('2026-11-12T19:52:55.000Z') },
			{ imdbId: CIVIL_WAR, kind: 'tv', title: 'The Civil War', year: 1990, added: Date.parse('2026-11-12T19:52:55.000Z') },
			{ imdbId: SHAWSHANK, kind: 'movie', title: 'The Shawshank Redemption', year: 1994, added: Date.parse('2026-11-12T19:52:52.000Z') },
			{ imdbId: BREAKING_BAD, kind: 'tv', title: 'Breaking Bad', year: 2008, added: Date.parse('2026-11-12T19:52:52.000Z') },
		]);
		// A list item Trakt has no year for (Elephant Dreams).
		expect(traktEntries(traktLikedItems.body)[1]).toEqual({ imdbId: 'tt0269188', kind: 'movie', title: 'Elephant Dreams', added: Date.parse('2026-08-21T21:02:52.000Z') });
	});

	it("reads Simkl's statuses from the history's answer: Plan to Watch first, anime by its own type, empty ones left out", () => {
		const lists = simklLists(simklAllItems.body);
		expect(lists.map((list) => [list.id, list.name, list.kind, list.items.length])).toEqual([
			['plantowatch', 'Plan to Watch', 'watchlist', 6],
			['watching', 'Watching', 'status', 4],
			['completed', 'Completed', 'status', 5],
		]);
		expect(lists[0].items.find((item) => item.title === 'Sousou no Frieren')).toMatchObject({ kind: 'tv', year: 2023 });
		expect(lists[2].items.find((item) => item.imdbId === YOUR_NAME)).toMatchObject({ kind: 'movie', title: 'Kimi no Na wa.' });
	});
});

describe('Home’s Watchlist row', () => {
	it('joins both watchlists newest first, each title once, what the library holds first', () => {
		const both = watchlist([...traktLists(), ...simklLists(simklAllItems.body)], inLibrary);
		// 4 on Trakt and 6 on Simkl's Plan to Watch, three of them on both.
		expect(both.map((item) => item.imdbId)).toEqual([CIVIL_WAR, BUNNY, BREAKING_BAD, SHAWSHANK, 'tt15239678', 'tt11280740', 'tt22248376']);
		// The newer of the two is kept (Simkl's, added a minute after Trakt's).
		expect(both[1].added).toBe(Date.parse('2026-11-12T19:53:41Z'));
	});

	it('lists one tracker alone, and nothing without one', () => {
		expect(watchlist(traktLists(), inLibrary).map((item) => item.imdbId)).toEqual([CIVIL_WAR, BUNNY, SHAWSHANK, BREAKING_BAD]);
		expect(watchlist(simklLists(simklAllItems.body), inLibrary)).toHaveLength(6);
		expect(watchlist([], inLibrary)).toEqual([]);
	});

	it('matches films and shows by IMDb id against the library, anime included', () => {
		const status = (lists: TrackerList[], id: string) => lists.find((list) => list.id === id)!.items.map((item) => [item.imdbId, inLibrary(item.imdbId)]);
		const simkl = simklLists(simklAllItems.body);
		expect(status(traktLists(), OWN_LIST)).toEqual([['tt1727587', false], [BIRDS_OF_PREY, true], ['tt0133093', false], ['tt11280740', false]]);
		expect(status(simkl, 'watching')).toEqual(expect.arrayContaining([[WEEDS, true], [MHA, true], ['tt0103549', false]]));
		// An anime film is a film: not in this library.
		expect(status(simkl, 'completed')).toEqual(expect.arrayContaining([[YOUR_NAME, false], [CIVIL_WAR, true], [BIRDS_OF_PREY, true]]));
	});
});

describe('keeping the lists on the device', () => {
	const TRAKT_LISTS = {
		'GET /sync/last_activities': ok(traktActivities),
		'GET /sync/watchlist/movies,shows/added/desc': ok(traktWatchlist),
		'GET /users/me/lists': ok(traktOwn),
		'GET /users/me/likes/lists': ok(traktLiked),
		[`GET /lists/${OWN_LIST}/items/movie,show`]: ok(traktOwnItems),
		[`GET /lists/${LIKED_LIST}/items/movie,show`]: ok(traktLikedItems),
	};
	// Joined already, history and resume points as read: only the lists are new.
	const joined = (api: typeof TRAKT, activities: unknown) => ({ joined: true, ...api.stamps(activities), playback: {}, unsent: {}, drops: [] });

	async function trakt(routes: Record<string, TraktReply>, state: unknown = joined(TRAKT, traktActivities.body)) {
		const account = new TraktAccount({ pull: async () => null, changed: () => undefined }, vi.fn(), memory(), () => NOW);
		await account.connect({ accessToken: 'AT', refreshToken: 'RT', expiresAt: NOW + 7 * DAY });
		const { calls, http } = fake(routes);
		const clock = { now: NOW };
		const sync = new TrackerSync(account, new WatchStore(memory(), () => NOW), () => false, memory(state), http, () => clock.now, async () => undefined);
		return { sync, calls, clock, account };
	}

	it("reads Trakt's watchlist, own and liked lists once, then only what changed; a liked list again hourly or on pull to refresh", async () => {
		const routes: Record<string, TraktReply> = { ...TRAKT_LISTS };
		const { sync, calls, clock, account } = await trakt(routes);
		await sync.sync(true);
		expect(calls).toEqual([
			'/sync/last_activities',
			'/sync/watchlist/movies,shows/added/desc?page=1&limit=250',
			'/users/me/lists?page=1&limit=250',
			'/users/me/likes/lists?page=1&limit=250',
			`/lists/${OWN_LIST}/items/movie,show?page=1&limit=250`,
			`/lists/${LIKED_LIST}/items/movie,show?page=1&limit=250`,
		]);
		expect(sync.lists().map((list) => [list.id, list.name, list.kind, list.items.length, list.owner])).toEqual([
			['watchlist', 'Watchlist', 'watchlist', 4, undefined],
			[OWN_LIST, 'DMM Mobile test', 'own', 4, undefined],
			[LIKED_LIST, 'Citadel Movies', 'liked', 6, 'list-owner'],
		]);

		// Coming back within a minute: nothing; after it, the stamps alone (they did not move).
		calls.length = 0;
		await sync.sync();
		clock.now += 2 * MIN;
		await sync.sync();
		expect(calls).toEqual(['/sync/last_activities']);

		// Pull to refresh: liked lists change with their owners, so the summaries are read again; unchanged lists' items are not.
		calls.length = 0;
		await sync.sync(true);
		expect(calls).toEqual(['/sync/last_activities', '/sync/watchlist/movies,shows/added/desc?page=1&limit=250', '/users/me/lists?page=1&limit=250', '/users/me/likes/lists?page=1&limit=250']);

		// An item added to the own list on trakt.tv moves lists.updated_at and that list's updated_at: only it is read again.
		const later = '2026-11-12T20:30:00.000Z';
		const own = [{ ...traktOwn.body[0], updated_at: later, item_count: 5 }];
		Object.assign(routes, { 'GET /sync/last_activities': { status: 200, data: { ...traktActivities.body, lists: { ...traktActivities.body.lists, updated_at: later } } }, 'GET /users/me/lists': { status: 200, data: own, pageCount: 1 } });
		calls.length = 0;
		clock.now += 2 * MIN;
		await sync.sync();
		expect(calls.filter((path) => path.startsWith('/lists/'))).toEqual([`/lists/${OWN_LIST}/items/movie,show?page=1&limit=250`]);

		// Disconnected: no lists.
		await account.disconnect();
		expect(sync.lists()).toEqual([]);
	});

	it('takes Simkl’s statuses from the answer the history is read from: one request for both', async () => {
		const account = new SimklAccount(vi.fn(), memory(), () => NOW);
		await account.connect({ accessToken: 'AT', refreshToken: 'RT', expiresAt: NOW + 7 * DAY, scope: 'media:read media:write' });
		const { calls, http } = fake({ 'GET /sync/activities': ok(simklActivities), 'GET /sync/all-items': ok(simklAllItems), 'GET /sync/playback': { status: 200, data: [] } });
		const sync = new TrackerSync(account, new WatchStore(memory(), () => NOW), () => false, memory(), http, () => NOW, async () => undefined, SIMKL);
		await sync.sync(true);
		expect(calls.filter((path) => path.startsWith('/sync/all-items'))).toHaveLength(1);
		expect(sync.lists().map((list) => list.name)).toEqual(['Plan to Watch', 'Watching', 'Completed']);
		// Nothing moved: no further reads, also on pull to refresh (Simkl's 500 requests a day).
		calls.length = 0;
		await sync.sync(true);
		expect(calls).toEqual(['/sync/activities']);
	});

	it('reads the lists once after an update from the version without them, even when no stamp moved', async () => {
		const account = new SimklAccount(vi.fn(), memory(), () => NOW);
		await account.connect({ accessToken: 'AT', refreshToken: 'RT', expiresAt: NOW + 7 * DAY, scope: 'media:read media:write' });
		const { calls, http } = fake({ 'GET /sync/activities': ok(simklActivities), 'GET /sync/all-items': ok(simklAllItems) });
		const sync = new TrackerSync(account, new WatchStore(memory(), () => NOW), () => false, memory(joined(SIMKL, simklActivities.body)), http, () => NOW, async () => undefined, SIMKL);
		await sync.sync(true);
		expect(calls.map((path) => path.split('?')[0])).toEqual(['/sync/activities', '/sync/all-items']);
		expect(sync.lists()[0].items.map((item) => item.title)).toContain('Big Buck Bunny');
	});
});
