import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-secure-store', () => ({ getItemAsync: vi.fn(async () => null), setItemAsync: vi.fn(), deleteItemAsync: vi.fn() }));
vi.mock('expo-file-system', () => ({ File: class {}, Paths: {} }));

import { alertDiff, alertsFor, ALERT_LIMIT, airTime, byDay, calendarOf, CalendarStore, dayLabel, dayStart, fromShowInfo, fromTraktCalendar, episodeTitles, fromTraktSeason, heldCopies, otherCopies, readEpisodeTitles, yourShows, type CalendarEpisode, type GetJson } from './calendar';
import type { TrackerList } from './lists';
import type { LibraryItem } from './model';
import { findEpisode, showEpisodes } from './titles';
import sightingsFiles from './test/fixtures/rd-show-files-sightings-2026-11-12.json';
// Trakt's /shows/tt0103549/seasons?extended=episodes, 2026-11-13; ids dropped
import sightingsTitles from './test/fixtures/trakt-seasons-episodes-sightings-2026-11-13.json';
import traktCalendar from './test/fixtures/trakt-calendar-my-shows-2026-11-12.json';
import jojoSeason from './test/fixtures/trakt-season-jojo-s06-2026-11-12.json';
import abbottSeason from './test/fixtures/trakt-season-abbott-elementary-s06-2026-11-12.json';
import jojoInfo from './test/fixtures/dmm-info-show-jojo-2026-11-12.json';
import abbottInfo from './test/fixtures/dmm-info-show-abbott-elementary-2026-11-12.json';
import tulsaInfo from './test/fixtures/dmm-info-show-tulsa-king-2026-11-12.json';
import sightingsInfo from './test/fixtures/dmm-info-show-sightings-2026-11-12.json';

/** The Trakt test account's calendar (JoJo watched, Stick on the watchlist) and DMM's and Trakt's answers, all read 2026-11-12. */
const NOW = Date.parse('2026-11-12T20:00:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const JOJO = { imdbId: 'tt2359704', title: "JoJo's Bizarre Adventure" };
const STICK = 'tt31710249';
const ABBOTT = { imdbId: 'tt14218830', title: 'Abbott Elementary' };
const TULSA = { imdbId: 'tt16358384', title: 'Tulsa King' };
const SIGHTINGS = { imdbId: 'tt0103549', title: 'Sightings' };
const codes = (episodes: readonly CalendarEpisode[]) => episodes.map((ep) => `${ep.show} ${ep.season}x${ep.episode} ${new Date(ep.airsAt).toISOString()}${ep.timed ? '' : ' (date)'}`);

let zone: string | undefined;
const inZone = (tz: string) => {
	process.env.TZ = tz;
};
beforeEach(() => {
	zone = process.env.TZ;
	inZone('Europe/Berlin');
});
afterEach(() => {
	process.env.TZ = zone;
});

describe('sources', () => {
	it("reads Trakt's calendar of the user's shows: watched (JoJo) and watchlisted (Stick) alike", () => {
		const episodes = fromTraktCalendar(traktCalendar.body);
		expect(episodes).toHaveLength(10);
		expect(episodes[0]).toEqual({ imdbId: JOJO.imdbId, show: JOJO.title, season: 6, episode: 8, title: 'Tusk (2)', airsAt: Date.parse('2026-11-06T07:00:00Z'), timed: true });
		expect(new Set(episodes.map((ep) => ep.imdbId))).toEqual(new Set([JOJO.imdbId, STICK]));
	});

	it("takes DMM's last and next episode, and drops what has no IMDb id, number or date", () => {
		expect(codes(fromShowInfo(TULSA, tulsaInfo))).toEqual(['Tulsa King 4x4 2026-11-06T12:00:00.000Z', 'Tulsa King 4x5 2026-11-13T12:00:00.000Z']);
		expect(codes(fromShowInfo(SIGHTINGS, sightingsInfo))).toEqual(['Sightings 6x5 1998-12-23T17:00:00.000Z']);
		expect(fromShowInfo(SIGHTINGS, { next_episode_to_air: { season_number: 1, episode_number: 2, first_aired: '' } })).toEqual([]);
		expect(fromShowInfo({ imdbId: 'not-an-id', title: 'x' }, tulsaInfo)).toEqual([]);
	});

	it("reads a season from Trakt's public season list with every air time", () => {
		const episodes = fromTraktSeason(ABBOTT, abbottSeason);
		expect(episodes.map((ep) => ep.episode)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
		expect(episodes[6]).toMatchObject({ season: 6, episode: 7, title: 'One Hundred', airsAt: Date.parse('2026-12-03T01:30:00Z'), timed: true });
	});

	it('a bare date is that day here, with no time', () => {
		inZone('America/Los_Angeles');
		expect(airTime('2026-11-18')).toEqual({ airsAt: new Date(2026, 10, 18).getTime(), timed: false });
		expect(new Date(airTime('2026-11-18')!.airsAt).getDate()).toBe(18);
		expect(airTime('soon')).toBeNull();
		expect(airTime(null)).toBeNull();
	});
});

describe('the calendar', () => {
	it('joins the sources, each episode once by show and number, in air order', () => {
		const joined = calendarOf([fromTraktCalendar(traktCalendar.body), fromShowInfo(JOJO, jojoInfo)], NOW);
		expect(joined).toHaveLength(10);
		expect(joined.filter((ep) => ep.imdbId === JOJO.imdbId).map((ep) => ep.episode)).toEqual([8, 9, 10, 11, 12]);
		expect(joined.map((ep) => ep.airsAt)).toEqual([...joined.map((ep) => ep.airsAt)].sort((a, b) => a - b));
	});

	it('keeps an exact time over a bare date for the same episode, whichever came first', () => {
		const dated = { ...fromShowInfo(TULSA, tulsaInfo)[1], airsAt: new Date(2026, 10, 13).getTime(), timed: false };
		const timed = fromShowInfo(TULSA, tulsaInfo)[1];
		expect(calendarOf([[dated], [timed]], NOW)).toEqual([timed]);
		expect(calendarOf([[timed], [dated]], NOW)).toEqual([timed]);
	});

	it('spans the last 7 and the next 30 whole local days', () => {
		const at = (iso: string, episode: number) => ({ imdbId: JOJO.imdbId, show: JOJO.title, season: 1, episode, airsAt: Date.parse(iso), timed: true });
		// Berlin: the window is 5 November 00:00 to 12 December 23:59 local time.
		const inside = [at('2026-11-04T23:00:00.000Z', 1), at('2026-12-12T22:59:00.000Z', 2)];
		const outside = [at('2026-11-04T22:59:00.000Z', 3), at('2026-12-12T23:00:00.000Z', 4)];
		expect(calendarOf([[...inside, ...outside]], NOW)).toEqual(inside);
	});

	it("starts 7 days back at local midnight across a daylight saving change, not 7 x 24 hours back", () => {
		inZone('America/New_York');
		// New York left daylight saving time on 1 November 2026: 29 October began at 04:00 UTC, not 05:00.
		const now = Date.parse('2026-11-05T17:00:00Z');
		expect(new Date(dayStart(now, -7)).toISOString()).toBe('2026-10-29T04:00:00.000Z');
		const justAfterMidnight = { imdbId: JOJO.imdbId, show: JOJO.title, season: 1, episode: 1, airsAt: Date.parse('2026-10-29T04:30:00Z'), timed: true };
		expect(calendarOf([[justAfterMidnight]], now)).toEqual([justAfterMidnight]);
	});

	it("groups by the device's day: Stick's 02:00 UTC episode is the evening before in New York, the next morning in Berlin and Tokyo", () => {
		const stick = fromTraktCalendar(traktCalendar.body).filter((ep) => ep.imdbId === STICK && ep.episode === 3);
		const dayOf = () => new Date(byDay(stick)[0].day).toDateString();
		inZone('America/New_York');
		expect(dayOf()).toBe('Tue Nov 10 2026');
		inZone('Europe/Berlin');
		expect(dayOf()).toBe('Wed Nov 11 2026');
		inZone('Asia/Tokyo');
		expect(dayOf()).toBe('Wed Nov 11 2026');
	});

	it('keeps the two days around a daylight saving change apart', () => {
		inZone('America/New_York');
		const late = (iso: string, episode: number) => ({ imdbId: JOJO.imdbId, show: JOJO.title, season: 1, episode, airsAt: Date.parse(iso), timed: true });
		// 23:30 on 31 October (EDT) and on 1 November (EST): 25 hours apart.
		const days = byDay([late('2026-11-01T03:30:00Z', 1), late('2026-11-02T04:30:00Z', 2)]);
		expect(days.map(({ day, episodes }) => [new Date(day).toDateString(), episodes.map((ep) => ep.episode)])).toEqual([
			['Sat Oct 31 2026', [1]],
			['Sun Nov 01 2026', [2]],
		]);
	});

	it('names the days next to today', () => {
		expect(dayLabel(dayStart(NOW), NOW)).toBe('Today');
		expect(dayLabel(dayStart(NOW, 1), NOW)).toBe('Tomorrow');
		expect(dayLabel(dayStart(NOW, -1), NOW)).toBe('Yesterday');
		expect(dayLabel(dayStart(NOW, 3), NOW)).toMatch(/Nov/);
	});
});

describe('your shows and the library', () => {
	const row = (id: string, filename: string, files: string[]): LibraryItem => ({ id, provider: 'rd', title: filename, filename, hash: id, size: 1, progress: 100, status: 'finished', serviceStatus: 'downloaded', added: '2026-11-01T00:00:00Z', files: files.map((name, n) => ({ id: String(n + 1), name, size: 1_000_000_000 })), filesLoaded: true });

	it('an aired episode is in the library when a file holds it, a two-episode file included', () => {
		const release = row('rd:1', "JoJo's.Bizarre.Adventure.S06E07-E08.1080p.WEB.H264", ["JoJo's.Bizarre.Adventure.S06E07-E08.1080p.WEB.H264.mkv"]);
		const single = row('rd:2', "JoJo's.Bizarre.Adventure.S06E06.1080p.WEB.H264", ["JoJo's.Bizarre.Adventure.S06E06.1080p.WEB.H264.mkv"]);
		const show = showEpisodes([{ item: release, files: release.files }, { item: single, files: single.files }]);
		expect(heldCopies(show, 6, 8).map((copy) => copy.item.id)).toEqual(['rd:1']);
		expect(heldCopies(show, 6, 7).map((copy) => copy.item.id)).toEqual(['rd:1']);
		expect(heldCopies(show, 6, 6).map((copy) => copy.item.id)).toEqual(['rd:2']);
		expect(heldCopies(show, 6, 9)).toEqual([]);
		expect(heldCopies(show, 5, 8)).toEqual([]);
	});

	it("are the library's shows and Simkl's watching and plan to watch; films and Trakt's lists are left to Trakt's calendar", () => {
		const simkl: TrackerList[] = [
			{ id: 'watching', name: 'Watching', kind: 'status', items: [{ imdbId: ABBOTT.imdbId, kind: 'tv', title: ABBOTT.title }] },
			{ id: 'plantowatch', name: 'Plan to Watch', kind: 'watchlist', items: [{ imdbId: TULSA.imdbId, kind: 'tv', title: TULSA.title }, { imdbId: 'tt0111161', kind: 'movie', title: 'The Shawshank Redemption' }] },
			{ id: 'dropped', name: 'Dropped', kind: 'status', items: [{ imdbId: 'tt0000002', kind: 'tv', title: 'Dropped show' }] },
		];
		const trakt: TrackerList[] = [{ id: 'watchlist', name: 'Watchlist', kind: 'watchlist', items: [{ imdbId: STICK, kind: 'tv', title: 'Stick' }] }];
		const library = [{ ...JOJO, kind: 'tv' as const }, { imdbId: 'tt1254207', title: 'Big Buck Bunny', kind: 'movie' as const }];
		expect(yourShows(library, [{ tracker: { api: { id: 'trakt' } }, lists: trakt }, { tracker: { api: { id: 'simkl' } }, lists: simkl }])).toEqual([JOJO, ABBOTT, TULSA]);
	});
});

describe('alerts', () => {
	const episodes = calendarOf([fromTraktCalendar(traktCalendar.body)], NOW);

	it('one per episode still to air, at its air time', () => {
		const alerts = alertsFor(episodes, NOW);
		expect(alerts).toHaveLength(8);
		expect(alerts[0]).toEqual({ id: `episode:${JOJO.imdbId}:6:9`, at: Date.parse('2026-11-13T07:00:00Z'), title: JOJO.title, body: 'S06E09 "Frightening Monsters (1)" is out now' });
		expect(alertsFor(episodes, Date.parse('2026-11-13T07:00:00Z'))[0].id).toBe(`episode:${STICK}:2:4`);
	});

	it('at 9:00 that day when only the date is known, and never more than iOS keeps', () => {
		const dated = { ...episodes[3], timed: false, airsAt: new Date(2026, 10, 18).getTime() };
		expect(alertsFor([dated], NOW)[0]).toMatchObject({ at: new Date(2026, 10, 18, 9).getTime(), body: 'S02E04 "The Boog" comes out today' });
		const many = Array.from({ length: 80 }, (_, n) => ({ ...episodes[3], episode: n + 1, airsAt: NOW + (n + 1) * HOUR }));
		expect(alertsFor(many, NOW)).toHaveLength(ALERT_LIMIT);
		expect(alertsFor(many, NOW).at(-1)!.at).toBe(NOW + ALERT_LIMIT * HOUR);
	});

	it('a refresh cancels what left or moved and schedules only what is new or moved', () => {
		const before = alertsFor(episodes, NOW);
		const moved = { ...episodes.find((ep) => ep.imdbId === STICK && ep.episode === 4)!, airsAt: Date.parse('2026-11-18T03:00:00Z') };
		const after = alertsFor([...episodes.filter((ep) => !(ep.imdbId === STICK && ep.episode === 4) && !(ep.imdbId === JOJO.imdbId && ep.episode === 12)), moved], NOW);
		const diff = alertDiff(before, after);
		expect(diff.cancel.sort()).toEqual([`episode:${JOJO.imdbId}:6:12`, `episode:${STICK}:2:4`]);
		expect(diff.add.map((alert) => [alert.id, new Date(alert.at).toISOString()])).toEqual([[`episode:${STICK}:2:4`, '2026-11-18T03:00:00.000Z']]);
		expect(alertDiff(after, after)).toEqual({ cancel: [], add: [] });
		expect(alertDiff([], after).add).toHaveLength(after.length);
	});
});

describe('the store', () => {
	const memory = () => {
		let text: string | null = null;
		return { read: async () => text, write: async (next: string) => void (text = next) };
	};
	/** DMM and Trakt answering from the captured replies; anything else is a 404. */
	const fake = () => {
		const calls: string[] = [];
		const answers: Record<string, unknown> = {
			[`/api/info/show?imdbid=${JOJO.imdbId}`]: jojoInfo,
			[`/api/info/show?imdbid=${ABBOTT.imdbId}`]: abbottInfo,
			[`/api/info/show?imdbid=${TULSA.imdbId}`]: tulsaInfo,
			[`/api/info/show?imdbid=${SIGHTINGS.imdbId}`]: sightingsInfo,
			[`/shows/${JOJO.imdbId}/seasons/6?extended=full`]: jojoSeason,
			[`/shows/${ABBOTT.imdbId}/seasons/6?extended=full`]: abbottSeason,
		};
		const get: GetJson = async (url, headers) => {
			const path = url.replace(/^https:\/\/[^/]+/, '');
			calls.push(path);
			if (path.startsWith('/shows/') && headers?.['trakt-api-key'] === undefined) throw new Error('no client id');
			if (!(path in answers)) throw new Error('404');
			return answers[path];
		};
		return { calls, get };
	};
	const traktReader = (calls: string[]) => ({ read: async (path: string) => (calls.push(`trakt ${path}`), traktCalendar.body) });

	it("reads Trakt's calendar once, and only the shows it does not cover from DMM, with Trakt's season where one airs", async () => {
		let now = NOW;
		const { calls, get } = fake();
		const store = new CalendarStore(memory(), get, () => now);
		const shows = [JOJO, ABBOTT, TULSA, SIGHTINGS];
		const trakt = traktReader(calls);
		await store.refresh(shows, trakt);
		expect(calls).toEqual([
			'trakt /calendars/my/shows/2026-11-03/40',
			`/api/info/show?imdbid=${ABBOTT.imdbId}`,
			`/api/info/show?imdbid=${TULSA.imdbId}`,
			`/api/info/show?imdbid=${SIGHTINGS.imdbId}`,
			`/shows/${ABBOTT.imdbId}/seasons/6?extended=full`,
			// Not on Trakt's public list here: DMM's last and next stand.
			`/shows/${TULSA.imdbId}/seasons/4?extended=full`,
		]);
		const listed = codes(store.episodes(shows, true));
		expect(listed).toContain('Abbott Elementary 6x5 2026-11-05T01:30:00.000Z');
		expect(listed).toContain('Abbott Elementary 6x8 2026-12-10T01:30:00.000Z');
		expect(listed).not.toContain('Abbott Elementary 6x9 2027-01-14T01:30:00.000Z');
		expect(listed).toContain('Tulsa King 4x5 2026-11-13T12:00:00.000Z');
		expect(listed.filter((line) => line.startsWith('Stick'))).toHaveLength(5);
		expect(listed.some((line) => line.startsWith('Sightings'))).toBe(false);

		// Nothing is due a minute later; a pull to refresh reads Trakt and the shows airing now, not the ended one.
		calls.length = 0;
		now += MIN;
		await store.refresh(shows, trakt);
		expect(calls).toEqual([]);
		await store.refresh(shows, trakt, true);
		expect(calls).toEqual(['trakt /calendars/my/shows/2026-11-03/40', `/api/info/show?imdbid=${ABBOTT.imdbId}`, `/api/info/show?imdbid=${TULSA.imdbId}`, `/shows/${ABBOTT.imdbId}/seasons/6?extended=full`, `/shows/${TULSA.imdbId}/seasons/4?extended=full`]);

		// Half a day later the airing shows are due again; the ended one waits a month.
		calls.length = 0;
		now += 13 * HOUR;
		await store.refresh(shows, trakt);
		expect(calls.filter((call) => call.includes(SIGHTINGS.imdbId))).toEqual([]);
		expect(calls).toContain(`/api/info/show?imdbid=${ABBOTT.imdbId}`);
		calls.length = 0;
		now += 31 * DAY;
		await store.refresh([SIGHTINGS], null);
		expect(calls).toEqual([`/api/info/show?imdbid=${SIGHTINGS.imdbId}`]);
	});

	it("without Trakt, a show Trakt's calendar covered comes from DMM and Trakt's season list, and Trakt's calendar is gone", async () => {
		const { calls, get } = fake();
		const saved = memory();
		const store = new CalendarStore(saved, get, () => NOW);
		await store.refresh([JOJO], traktReader(calls));
		expect(store.episodes([JOJO], false)).toEqual([]);
		calls.length = 0;
		await store.refresh([JOJO], null);
		expect(calls).toEqual([`/api/info/show?imdbid=${JOJO.imdbId}`, `/shows/${JOJO.imdbId}/seasons/6?extended=full`]);
		expect(store.episodes([JOJO, { imdbId: STICK, title: 'Stick' }], true).map((ep) => `${ep.imdbId} ${ep.episode}`)).toEqual([8, 9, 10, 11, 12].map((n) => `${JOJO.imdbId} ${n}`));

		// Kept between launches: a new store answers from the file without asking anyone.
		calls.length = 0;
		const later = new CalendarStore(saved, get, () => NOW);
		await later.load();
		expect(later.episodes([JOJO], false)).toEqual(store.episodes([JOJO], false));
		await later.refresh([JOJO], null);
		expect(calls).toEqual([]);
	});

	it('keeps what was read before when DMM cannot be reached, and says so', async () => {
		const { get } = fake();
		let offline = false;
		let now = NOW;
		const store = new CalendarStore(memory(), (url, headers) => (offline ? Promise.reject(new Error('offline')) : get(url, headers)), () => now);
		await store.refresh([ABBOTT], null);
		offline = true;
		now += 13 * HOUR;
		const before = store.episodes([ABBOTT], false);
		expect(before.length).toBeGreaterThan(0);
		await store.refresh([ABBOTT], null);
		expect(store.error).toMatch(/Could not reach DMM/);
		expect(store.episodes([ABBOTT], false)).toEqual(before);
	});
});

describe("the player's episode facts", () => {
	it("names episodes from Trakt's season list, specials included", async () => {
		const titles = episodeTitles(sightingsTitles);
		expect(titles.get('1:2')).toBe('Psychic Healing');
		expect(titles.get('0:1')).toBe('The UFO Report VHS Release');
		expect(titles.size).toBe(113);
		expect(episodeTitles([{ number: 1 }, null, { episodes: [{ season: 1, number: 3, title: '' }] }]).size).toBe(0);
		const get = vi.fn<GetJson>(async () => sightingsTitles);
		await readEpisodeTitles('tt0103549', get);
		expect((await readEpisodeTitles('tt0103549', get)).get('5:20')).toBeTruthy();
		expect(get).toHaveBeenCalledTimes(1);
		expect(get.mock.calls[0][0]).toBe('https://api.trakt.tv/shows/tt0103549/seasons?extended=episodes');
	});

	it('a read that failed is tried again', async () => {
		const get = vi.fn<GetJson>().mockRejectedValueOnce(new Error('503')).mockResolvedValueOnce(sightingsTitles);
		await expect(readEpisodeTitles('tt-failing', get)).rejects.toThrow('503');
		expect((await readEpisodeTitles('tt-failing', get)).size).toBe(113);
	});

	// rd6893c80a7036's Sightings (2026-11-12) on Real-Debrid and the same release on TorBox: "1x06-07" holds episode 7, beside its own "1x07".
	it('offers the other copies of the episode that plays, never a double episode for one of its halves', () => {
		const files = sightingsFiles.files.map((file) => ({ id: String(file.id), name: file.path, size: file.bytes, selected: file.selected === 1 }));
		const rd = { id: 'rd:QP76YYG2XC6P2', provider: 'rd', title: sightingsFiles.filename, filename: sightingsFiles.filename, hash: sightingsFiles.hash, size: 1, progress: 100, status: 'finished', serviceStatus: 'downloaded', added: '2026-11-12T00:00:00Z', files } as LibraryItem;
		const tb = { ...rd, id: 'tb:42', provider: 'tb' } as LibraryItem;
		const show = showEpisodes([{ item: rd, files }, { item: tb, files }]);
		const fileId = (part: string) => files.find((file) => file.name.includes(part))!.id;
		const versions = (itemId: string, part: string) => otherCopies(show, findEpisode(show, itemId, fileId(part))!).map((copy) => `${copy.item.id} ${copy.file.name.split(' - ')[1]}`);
		expect(versions(rd.id, '1x02')).toEqual(['tb:42 1x02']);
		expect(versions(rd.id, '1x07 - ')).toEqual(['tb:42 1x07']);
		expect(versions(rd.id, '1x06-07')).toEqual(['tb:42 1x06-07']);
		expect(otherCopies(showEpisodes([{ item: rd, files }]), findEpisode(show, rd.id, fileId('1x02'))!)).toEqual([]);
	});
});
