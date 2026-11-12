import { describe, expect, it, vi } from 'vitest';
import type { LibraryFile, LibraryItem } from './model';
import { ProviderApiError } from './providerApi';
import { TitleIndex, type CacheStore } from './titleIndex';
import { askDmm, episodeOf, LoginRefused, groupTitles, identificationKey, mainFile, posterUrls, qualityOf, releaseSeason, seasonRange, showEpisodes, type Identification, type Post } from './titles';
import identifyFixture from './test/fixtures/dmm-identify-testacct123-2026-11-12.json';
import rdFiles from './test/fixtures/rd-show-files-testacct123-2026-11-12.json';
import sightings from './test/fixtures/rd-show-files-sightings-2026-11-12.json';

type Torrent = (typeof rdFiles.torrents)[keyof typeof rdFiles.torrents];
const torrents = rdFiles.torrents as Record<string, Torrent>;
const PM_LOGIN = { service: 'pm' as const, apiKey: 'pm-test' };

/** A library row as the app lists it: Real-Debrid's list carries no files. */
const row = (id: string, filename: string, hash: string, extra: Partial<LibraryItem> = {}): LibraryItem => ({
	id,
	provider: 'rd',
	title: filename,
	filename,
	hash,
	size: 1,
	progress: 100,
	status: 'finished',
	serviceStatus: 'downloaded',
	added: '2026-11-01T00:00:00Z',
	files: [],
	...extra,
});
const items = identifyFixture.items.map((entry) => row(entry.id, entry.filename, entry.hash, { size: entry.bytes, added: entry.added }));
/** The release's files as the app's detail request maps them (name = RD's path). */
const filesOf = (id: string): LibraryFile[] => torrents[id].files.map((file) => ({ id: String(file.id), name: file.path, size: file.bytes, selected: file.selected === 1 }));
const placed = (id: string, season: number | null = null) => torrents[id].files.map((file) => [file.path.split('/').pop(), episodeOf(file.path, season)]);

describe('episodeOf on real Real-Debrid file lists (testacct123, 2026-11-12)', () => {
	it('reads SxxEyy, NxNN and a multi-episode file', () => {
		expect(episodeOf(torrents.HM5WI7JFU7HRQ.files[5].path)).toEqual({ season: 8, episode: 12, end: 13 });
		expect(placed('5CU6N75BP5ZUC').filter(([name]) => String(name).endsWith('.mkv')).slice(0, 3)).toEqual([
			['The Six Million Dollar Man -- 4x01 -- The Return of Bigfoot (Part 1).mkv', { season: 4, episode: 1 }],
			['The Six Million Dollar Man -- 4x01 -- The Return of Bigfoot (Part 2).mkv', { season: 4, episode: 1 }],
			['The Six Million Dollar Man -- 4x02 -- Nightmare in the Sky.mkv', { season: 4, episode: 2 }],
		]);
		expect(episodeOf('/Rick and Morty  S3E01 - The Rickshank Rickdemption.mkv')).toEqual({ season: 3, episode: 1 });
		expect(episodeOf('/Season 1/Family Matters S01E01.AMZN.1080p.5.1.HEVC.x265.10bit-Bearfish.mkv')).toEqual({ season: 1, episode: 1 });
	});

	// rd6893c80a7036's "Sightings" (2026-11-12) names its double episodes "1x06-07"; they read as episode 6 alone.
	it('reads a double episode written 1x06-07 as both', () => {
		expect(episodeOf(sightings.files.find((file) => file.path.includes('1x06-07'))!.path)).toEqual({ season: 1, episode: 6, end: 7 });
		expect(episodeOf(sightings.files.find((file) => file.path.includes('3x08-09'))!.path)).toEqual({ season: 3, episode: 8, end: 9 });
		expect(episodeOf('/The Six Million Dollar Man -- 4x01 -- The Return of Bigfoot (Part 1).mkv')).toEqual({ season: 4, episode: 1 });
	});

	it('reads fansub numbering when the name or the release gives the season', () => {
		expect(episodeOf('/[Yuki] Chihayafuru S1 - 24 (BD 1080p Hi10 FLAC) [0670F602].mkv')).toEqual({ season: 1, episode: 24 });
		expect(episodeOf(torrents.KFAKB2SGUTDAO.files[0].path)).toEqual({ season: 2, episode: 1 });
		const heidi = torrents.ZUT2TSJVPQAWU;
		expect(releaseSeason(heidi.filename)).toBe(1);
		expect(episodeOf(heidi.files[0].path, 1)).toEqual({ season: 1, episode: 1, inferred: true });
	});

	it('leaves absolute numbering, extras and a film in a show pack unplaced', () => {
		expect(episodeOf(torrents['3YIR44MQ7572Y'].files[0].path, releaseSeason(torrents['3YIR44MQ7572Y'].filename))).toBeNull();
		expect(episodeOf('/[SubsPlease] Boku no Hero Academia - 168 (1080p) [68B2000A].mkv', releaseSeason('[SubsPlease] Boku no Hero Academia - 168 (1080p) [68B2000A].mkv'))).toBeNull();
		const southPark = placed('2CHSZZUOPVH3Q', releaseSeason(torrents['2CHSZZUOPVH3Q'].filename));
		expect(southPark.filter(([, ref]) => ref === null).map(([name]) => name).filter((name) => !/^(Season Preview|Deleted Scenes)\.mkv$/.test(String(name)))).toEqual([
			'6 Days to Air - The Making of South Park (2011).mkv',
			"Jay Leno's Appearance on South Park.mkv",
			'O Holy Night - Cartman Music Video.mkv',
			'Chocolate Salty Balls - Music Video.mkv',
			'South Park Bigger, Longer and Uncut (1992).mkv',
		]);
		expect(southPark.find(([name]) => String(name).includes('S25E06'))?.[1]).toEqual({ season: 25, episode: 6 });
		expect(placed('INVZ4PTLLTNKQ').every(([, ref]) => ref === null)).toBe(true);
		expect(placed('VYFNODUYKM2NY', 2).filter(([, ref]) => ref === null)).toHaveLength(2);
	});

	it('reads one season from a release name, none from a multi-season pack', () => {
		expect(releaseSeason('Weeds.S01-08.1080p.TrueHD.5.1.AVC.REMUX-FraMeSToR')).toBeNull();
		expect(releaseSeason('South Park - Seasons 1 to 25 (S01-S25) Master Collection')).toBeNull();
		expect(releaseSeason('Family.Matters.seasons.01-09.AMZN.1080p.10bit.hevc.x265-bearfish')).toBeNull();
		expect(releaseSeason('The.Boys.S04.Eng.Fre.Ger.Ita.Por.Spa.2160p.WEBMux.HDR10Plus.HDR.HEVC.DDP-SGF')).toBe(4);
		expect(releaseSeason('The Six Million Dollar Man (S4, Season 4) 1080p')).toBe(4);
	});
});

describe('qualityOf', () => {
	it('names resolution and the tags a copy is picked by', () => {
		expect(qualityOf('The.Mandalorian.S01.2160p.UHD.Blu-ray.Remux.HEVC.TrueHD.7.1.Atmos-SiCFoI')).toBe('4K Remux');
		expect(qualityOf('Star.Trek.Strange.New.Worlds.S01.UHD.BluRay.2160p.DTS-HD.MA.5.1.DV.HEVC.REMUX-FraMeSToR')).toBe('4K Remux DV');
		expect(qualityOf("[Some-Stuffs] Jojo's Bizarre Adventure Stone Ocean 33 (1920x1080 Blu-Ray Opus)")).toBe('1080p');
		expect(qualityOf('Pokémon (1997) Season 5 S05 (480p DVD x265 HEVC 10bit AAC 2.0 ImE)')).toBe('SD');
		expect(qualityOf('Season 01')).toBe('');
	});

	// Found on the Pixel 2026-11-12: every South Park file read 4K from the release's "[1080p-2160p ...]".
	it("reads a file's own resolution first and none from a range", () => {
		const southPark = torrents['2CHSZZUOPVH3Q'];
		const episodes = showEpisodes([{ item: row('rd:2CHSZZUOPVH3Q', southPark.filename, southPark.hash), files: filesOf('2CHSZZUOPVH3Q') }]);
		const qualities = new Set([...episodes.seasons.values()].flatMap((season) => [...season.values()].flat()).map((copy) => copy.quality));
		expect(qualities).toEqual(new Set(['']));
		expect(qualityOf('/Weeds.S08.1080p.TrueHD.5.1.AVC.REMUX-FraMeSToR/Weeds.S08E12-E13.It\'s.Time.1080p.DTS-HD.MA.7.1.AVC.REMUX-FraMeSToR.mkv', 'Weeds.S01-08.1080p.TrueHD.5.1.AVC.REMUX-FraMeSToR')).toBe('1080p Remux');
		expect(qualityOf('/Season 1/Show S01E01.mkv', 'Show.S01.2160p.WEB.h265')).toBe('4K');
	});
});

describe('groupTitles with DMM\'s real answers', () => {
	const answers = new Map(items.map((item, n) => [item.id, identifyFixture.identify.results[n] as Identification | null]));
	const { titles, other } = groupTitles(items, (item) => answers.get(item.id));

	it('puts every release of a title together and keeps unnamed ones in Other', () => {
		expect(other.map((item) => item.filename)).toEqual([
			"[Some-Stuffs] Jojo's Bizarre Adventure Stone Ocean 33 (1920x1080 Blu-Ray Opus) [18E17992].mkv",
			'Season 01',
			'Season 3',
			"[Some-Stuffs] Jojo's Bizarre Adventure Stone Ocean 30 (1920x1080 Blu-Ray Opus) [C8C04BD3].mkv",
			'[izu] Boku no Hero Academia the Movie - You`re Next (2024) [BD-Remux] [60D551DA].mkv',
		]);
		const heroAcademia = titles.find((title) => title.imdbId === 'tt5626028')!;
		expect(heroAcademia.items.map((item) => item.filename)).toEqual(['My.Hero.Academia.S04.P2.CRF-16.1080p.Blu-Ray.10-Bit.Dual-Audio.TrueHD.x265-iAHD', '[SubsPlease] Boku no Hero Academia - 168 (1080p) [68B2000A].mkv']);
		expect(heroAcademia.seasons).toEqual([4]);
		expect(titles.filter((title) => title.kind === 'movie')).toHaveLength(11);
		expect(new Set(titles.map((title) => title.imdbId)).size).toBe(titles.length);
	});

	// Found on the Pixel 2026-11-12: DMM's stored answers (/api/library/identified) carry no seasons, so shows read "Show".
	it("gives a show the season its release names when DMM's stored answer has none", () => {
		const stored = new Map(items.map((item, n) => [item.id, identifyFixture.identified.results[n] as Identification | null]));
		const fromStore = groupTitles(items, (item) => stored.get(item.id)).titles;
		expect(fromStore.find((title) => title.imdbId === 'tt5626028')!.seasons).toEqual([4]);
		expect(fromStore.find((title) => title.title === 'The Boys')!.seasons).toEqual([4]);
		expect(fromStore.find((title) => title.title === 'South Park')!.seasons).toEqual([]);
	});

	it('orders titles by their newest release', () => {
		const added = titles.map((title) => title.added);
		expect(added).toEqual([...added].sort((a, b) => b - a));
	});

	it('shows a season range', () => {
		expect(seasonRange(titles.find((title) => title.title === 'South Park')!.seasons)).toBe('S1–25');
		expect(seasonRange([2, 5])).toBe('S2, S5');
		expect(seasonRange([])).toBe('');
	});
});

describe('showEpisodes', () => {
	it("puts a show's episodes from several releases together and keeps the rest visible", () => {
		const mha = items.find((item) => item.hash === identifyFixture.items.find((entry) => entry.id === 'rd:4LT5BXQSVWDA6')!.hash)!;
		const absolute = items.find((item) => item.filename.startsWith('[SubsPlease] Boku no Hero Academia - 168'))!;
		const episodes = showEpisodes([
			{ item: mha, files: filesOf('4LT5BXQSVWDA6'), seasons: [4] },
			{ item: absolute, files: [{ id: '1', name: absolute.filename, size: 1_400_000_000 }], seasons: [] },
		]);
		expect([...episodes.seasons.keys()]).toEqual([4]);
		expect([...episodes.seasons.get(4)!.keys()]).toEqual([14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25]);
		expect(episodes.unplaced.map((copy) => copy.file.name)).toEqual([absolute.filename]);
	});

	it('moves a bare number past the season end to unplaced, keeps tagged ones', () => {
		const heidi = row('rd:ZUT2TSJVPQAWU', torrents.ZUT2TSJVPQAWU.filename, torrents.ZUT2TSJVPQAWU.hash);
		const files = filesOf('ZUT2TSJVPQAWU');
		const all = showEpisodes([{ item: heidi, files, seasons: [1] }]);
		expect([...all.seasons.get(1)!.keys()].slice(0, 3)).toEqual([1, 2, 3]);
		const capped = showEpisodes([{ item: heidi, files, seasons: [1] }], { '1': 2 });
		expect([...capped.seasons.get(1)!.keys()]).toEqual([1, 2]);
		expect(capped.unplaced).toHaveLength(files.length - 2);
	});

	it('skips files Real-Debrid did not select and non-videos', () => {
		const bananas = row('rd:RIXR6H7F4BYTE', torrents.RIXR6H7F4BYTE.filename, torrents.RIXR6H7F4BYTE.hash);
		const files = filesOf('RIXR6H7F4BYTE');
		const episodes = showEpisodes([{ item: bananas, files }]);
		const placedCount = [...episodes.seasons.values()].reduce((total, season) => total + season.size, 0);
		expect(placedCount + episodes.unplaced.length).toBe(files.filter((file) => /\.(mp4|mkv)$/.test(file.name) && file.selected).length);
	});

	// Found on Ben's iPhone 2026-11-12: South Park's Not placed list read "Season Preview.mkv" seven times, one per extras folder.
	it('labels a file by its folder too, so same-named extras stay apart', () => {
		const southPark = torrents['2CHSZZUOPVH3Q'];
		const { unplaced } = showEpisodes([{ item: row('rd:2CHSZZUOPVH3Q', southPark.filename, southPark.hash), files: filesOf('2CHSZZUOPVH3Q') }]);
		const previews = unplaced.filter((copy) => copy.file.name.endsWith('/Season Preview.mkv')).map((copy) => copy.label);
		expect(previews).toHaveLength(7);
		expect(new Set(previews).size).toBe(7);
		expect(previews[0]).toBe('S12 Extras/Season Preview.mkv');
		expect(unplaced.find((copy) => copy.file.name.endsWith('(1992).mkv'))?.label).toBe('South Park Bigger, Longer and Uncut (1992)[2160p]/South Park Bigger, Longer and Uncut (1992).mkv');
		const tensei = torrents.VYFNODUYKM2NY;
		const single = showEpisodes([{ item: row('rd:VYFNODUYKM2NY', tensei.filename, tensei.hash), files: filesOf('VYFNODUYKM2NY') }], undefined);
		expect(single.seasons.get(2)!.get(1)![0].label).toBe('[FLE] Tensei Shitara Slime Datta Ken - S02E01 - Rimuru\'s Busy Life [E411414C].mkv');
	});

	it("opens a film copy's biggest video", () => {
		const film = row('rd:x', 'Film.2020.1080p', '');
		expect(mainFile(film, [{ id: '1', name: 'Film.sample.mkv', size: 50_000_000 }, { id: '2', name: 'Film.2020.1080p.mkv', size: 9_000_000_000 }, { id: '3', name: 'Film.srt', size: 90_000 }])?.id).toBe('2');
	});
});

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => ({ status, ok: status >= 200 && status < 300, headers: { get: (name: string) => headers[name.toLowerCase()] ?? null }, json: async () => body });

describe('askDmm', () => {
	it('asks the stored answers first, then the identifier about the rest, with the login', async () => {
		const calls: { url: string; body: { items: { filename: string; hash?: string }[]; identity: unknown } }[] = [];
		const post: Post = async (url, body) => {
			calls.push({ url, body: body as (typeof calls)[number]['body'] });
			if (url.endsWith('/identified')) return json(200, identifyFixture.identified);
			const asked = (body as { items: { filename: string }[] }).items.map((entry) => entry.filename);
			return json(200, { results: asked.map((name) => identifyFixture.identify.results[identifyFixture.items.findIndex((entry) => entry.filename === name)]), complete: true });
		};
		const answers = new Map<string, Identification | null>();
		await askDmm(items, PM_LOGIN, (batch) => batch.forEach((value, key) => answers.set(key, value)), post);

		expect(calls.map((call) => call.url)).toEqual(['https://debridmediamanager.com/api/library/identified', 'https://debridmediamanager.com/api/library/identify']);
		expect(calls.every((call) => JSON.stringify(call.body.identity) === JSON.stringify(PM_LOGIN))).toBe(true);
		const stored = identifyFixture.identified.results.filter(Boolean).length;
		expect(calls[1].body.items).toHaveLength(items.length - stored);
		expect(answers.size).toBe(items.length);
		expect(answers.get(identificationKey(items[0]))).toMatchObject({ imdbId: 'tt0121955', kind: 'tv' });
		expect([...answers.values()].filter((value) => value === null)).toHaveLength(5);
	});

	it('waits out a refusal, keeps names the identifier could not reach unanswered, and stops on a refused login', async () => {
		const wait = vi.fn(async () => undefined);
		const replies = [json(429, {}, { 'retry-after': '7' }), json(200, { results: [null, { imdbId: 'tt1', title: 'A', year: 2001, kind: 'movie' }], complete: false })];
		const answers = new Map<string, Identification | null>();
		const hashless = [row('pm:1', 'A.2001.1080p.mkv', ''), row('pm:2', 'B.2002.1080p.mkv', '')];
		await askDmm(hashless, PM_LOGIN, (batch) => batch.forEach((value, key) => answers.set(key, value)), async () => replies.shift()!, wait);
		expect(wait).toHaveBeenCalledWith(7000);
		expect([...answers.entries()]).toEqual([['|B.2002.1080p.mkv', { imdbId: 'tt1', title: 'A', year: 2001, kind: 'movie' }]]);

		await expect(askDmm(hashless, PM_LOGIN, () => undefined, async () => json(403, { error: 'This endpoint serves DMM pages only.' }))).rejects.toThrow(LoginRefused);
	});
});

const memoryStore = (): CacheStore & { text: string | null } => {
	const store = { text: null as string | null, read: async () => store.text, write: async (text: string) => void (store.text = text) };
	return store;
};

describe('TitleIndex', () => {
	it('asks DMM once per release and remembers the answers across launches', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout'] });
		const post = vi.fn<Post>(async (url) => (url.endsWith('/identified') ? json(200, identifyFixture.identified) : json(200, { results: identifyFixture.identify.results.filter((_, n) => !identifyFixture.identified.results[n]), complete: true })));
		const store = memoryStore();
		const source = { identities: () => [PM_LOGIN], detail: vi.fn() };
		const index = new TitleIndex(source, store, post);
		await index.identify(items);
		expect(post).toHaveBeenCalledTimes(2);
		expect(index.identification(items[0])?.title).toBe('South Park');
		await vi.runAllTimersAsync();
		vi.useRealTimers();

		const relaunched = new TitleIndex(source, store, post);
		await relaunched.identify(items);
		expect(post).toHaveBeenCalledTimes(2);
		expect(relaunched.identification(items[0])?.title).toBe('South Park');
		expect(relaunched.identification(items.find((item) => item.filename === 'Season 01')!)).toBeNull();
	});

	it('asks again about a release DMM could not name a week ago', async () => {
		let now = Date.parse('2026-11-12T00:00:00Z');
		const post = vi.fn<Post>(async () => json(200, { results: [null], complete: true }));
		const junk = [row('rd:1', 'Season 01', 'a'.repeat(40))];
		const index = new TitleIndex({ identities: () => [PM_LOGIN], detail: vi.fn() }, memoryStore(), post, undefined, () => now);
		await index.identify(junk);
		await index.identify(junk);
		expect(post).toHaveBeenCalledTimes(2);
		now += 8 * 24 * 3600 * 1000;
		await index.identify(junk);
		expect(post).toHaveBeenCalledTimes(4);
	});

	it('tries the next login when DMM refuses one', async () => {
		const AD_LOGIN = { service: 'ad' as const, apiKey: 'ad-held' };
		const shown: unknown[] = [];
		const post = vi.fn<Post>(async (_url, body) => {
			const { identity } = body as { identity: { service: string } };
			shown.push(identity.service);
			return identity.service === 'ad' ? json(403, { error: 'This endpoint serves DMM pages only.' }) : json(200, { results: [{ imdbId: 'tt0121955', title: 'South Park', year: 1997, kind: 'tv' }], complete: true });
		});
		const index = new TitleIndex({ identities: () => [AD_LOGIN, PM_LOGIN], detail: vi.fn() }, memoryStore(), post);
		await index.identify([items[0]]);
		expect(shown).toEqual(['ad', 'pm']);
		expect(index.identification(items[0])?.title).toBe('South Park');
	});

	it('names the demo library without a login or DMM', async () => {
		const post = vi.fn<Post>();
		const index = new TitleIndex({ identities: () => [], detail: vi.fn() }, memoryStore(), post);
		const demo = row('tb:demo1', 'Tears of Steel (2012) 1080p', '209c8226b299b308beaf2b9cd3fb49212dbd13ec');
		await index.identify([demo]);
		expect(post).not.toHaveBeenCalled();
		expect(index.identification(demo)).toEqual({ imdbId: 'tt2285752', title: 'Tears of Steel', year: 2012, kind: 'movie' });
	});

	it("reads Real-Debrid file lists one at a time, waits out a 429, and keeps finished ones", async () => {
		let active = 0;
		let peak = 0;
		let refused = false;
		const rows = ['4LT5BXQSVWDA6', 'ZUT2TSJVPQAWU', 'KFAKB2SGUTDAO'].map((id) => row(`rd:${id}`, torrents[id].filename, torrents[id].hash));
		const detail = vi.fn(async (_provider: string, itemId: string) => {
			active++;
			peak = Math.max(peak, active);
			await Promise.resolve();
			active--;
			if (itemId === 'rd:ZUT2TSJVPQAWU' && !refused) {
				refused = true;
				throw new ProviderApiError('rd', 'Too many requests', 'too_many_requests', 429);
			}
			const id = itemId.slice(3);
			return { ...rows.find((item) => item.id === itemId)!, files: filesOf(id), filesLoaded: true };
		});
		const wait = vi.fn(async () => undefined);
		const index = new TitleIndex({ identities: () => [], detail }, memoryStore(), undefined, wait);
		const progress: string[] = [];
		await index.loadFiles(rows, (done, total) => progress.push(`${done}/${total}`));
		expect(peak).toBe(1);
		expect(wait).toHaveBeenCalledWith(5000);
		expect(progress).toEqual(['0/3', '1/3', '2/3', '3/3']);
		expect(rows.every((item) => index.filesOf(item)?.length)).toBe(true);
		await index.loadFiles(rows);
		expect(detail).toHaveBeenCalledTimes(4);
	});
});

describe('posterUrls', () => {
	it("spreads posters over DMM's CDN hosts as DMM web does, then metahub", () => {
		// DMM web's posterHost puts tt2285752 on posters1 (src/utils/posterHost.ts, 2026-11-12)
		expect(posterUrls('tt2285752')).toEqual(['https://posters1.debridmediamanager.com/tt2285752-small.jpg', 'https://images.metahub.space/poster/small/tt2285752/img']);
	});
});
