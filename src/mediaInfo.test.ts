import { describe, expect, it, vi } from 'vitest';
import { askProbes, channelLabel, copyDetails, copyFacts, filmProbe, languageCode, languageName, probeFor, releaseProbes, type FileProbe, type MediaInfoAnswer } from './mediaInfo';
import type { LibraryItem } from './model';
import { TitleIndex, type CacheStore } from './titleIndex';
import { LoginRefused, showEpisodes, type Post } from './titles';
import probes from './test/fixtures/dmm-mediainfo-2026-11-13.json';
import live from './test/fixtures/dmm-library-mediainfo-live-2026-11-13.json';
import sightings from './test/fixtures/rd-show-files-sightings-2026-11-12.json';

const releases = probes.releases as NonNullable<MediaInfoAnswer['releases']>;
/** The one probed file of a film release in the fixture. */
const film = (hash: string): FileProbe => releaseProbes(releases[hash])[0];
const line = (hash: string) => {
	const probe = film(hash);
	const facts = copyFacts(probe, probe.path);
	return [facts.picture.join(' · '), facts.sound.join(' · ')];
};

describe('a copy row from real stored probes', () => {
	it.each([
		// DV profile 8.1 whose probe names the PQ transfer; ffmpeg's numeric profile 30 is TrueHD Atmos
		['225956129403e3d923980a34dfd17ffbe2dd0f9a', '4K · DV P8.1 + HDR10 · HEVC 10-bit', 'TrueHD Atmos 7.1 · RU, EN · Subs RU, EN'],
		// DV 8.1 with no transfer in the probe: the DOVI record's compatibility id gives the fallback
		['cddd8e3413b13e083b332e79476ff6035c017a1b', '4K · DV P8.1 + HDR10 · HEVC 10-bit', 'DD+ Atmos 5.1 · RU, UK, EN · Subs RU, UK, EN'],
		// a UHD Blu-ray's DV profile 7 (compatibility id 6, HDR10 base layer)
		['cd34df9a44d278f1952926c269ad91b78537da0a', '4K · DV P7 + HDR10 · HEVC 10-bit', 'TrueHD Atmos 7.1 · EN · Subs EN, AR +24'],
		// HDR10+ is frame metadata no stream probe shows: the name adds it to the HDR10 layer; the best track, not the Russian default dub
		['69c97601dec7d1c3e9b1ce9f288fc898dacffb25', '4K · DV P7 + HDR10+ · HEVC 10-bit', 'TrueHD Atmos 7.1 · RU, UK, EN · Subs RU, UK, EN'],
		// a streaming service's DV profile 5: no fallback
		['1eb31028de739d420ac9c00f74e5986e633f4236', '4K · DV P5 · HEVC 10-bit', 'DD+ Atmos 5.1 · EN · Subs EN, AR +34'],
		['2967018e386b79cacdec0a892247bd7bea93fc30', '4K · HDR10 · HEVC 10-bit', 'TrueHD Atmos 7.1 · EN, FR +4 · Subs EN, FR +7'],
		// BBC iPlayer's HLG; its one subtitle track names no language
		['4a41f9f4f273a0b3ba1587456d60ef620adc35cc', '4K · HLG · HEVC 10-bit', 'AAC 2.0 · EN · Subs ×1'],
		// a 4K SDR remux says so; its only language is zxx (none)
		['425954ab0e1d129a2920c316b7307f83673b2537', '4K · SDR · HEVC 10-bit', 'DTS-HD MA 7.1'],
		['ed66d20f2c6c53b772d7bfe4b8171d84afd0175b', '1080p · H264', 'DTS-HD MA 5.1 · EN, ES · Subs EN, ES, FR'],
		['21d270b6110cdc2d8cba313a1185f48e10be9604', '1080p · HEVC 10-bit', 'Opus 5.1 · JA, EN · Subs EN, AR +24'],
		['025b41474869f9cfd05bbf2712f3d6d004aeff09', '4K · DV P8.1 + HDR10 · HEVC 10-bit', 'DD 5.1 · FR, EN · Subs FR'],
	])('%s', (hash, picture, sound) => {
		expect(line(hash)).toEqual([picture, sound]);
	});

	it('takes HDR from the name only when the probe says nothing about it', () => {
		const silent = { ...film('2967018e386b79cacdec0a892247bd7bea93fc30') };
		silent.video = { ...silent.video!, transfer: undefined };
		expect(copyFacts(silent, 'Birds.of.Prey.2020.2160p.BluRay.REMUX.HEVC.HDR10Plus').picture).toEqual(['4K', 'HDR10+', 'HEVC 10-bit']);
		expect(copyFacts(silent, 'Birds.of.Prey.2020.2160p.BluRay.REMUX.HEVC').picture).toEqual(['4K', 'HEVC 10-bit']);
		// the probe's SDR outranks a name that claims HDR
		expect(copyFacts(film('425954ab0e1d129a2920c316b7307f83673b2537'), 'Flow.2024.2160p.HDR').picture).toEqual(['4K', 'SDR', 'HEVC 10-bit']);
	});
});

describe('the details view', () => {
	const texts = (hash: string, title: string) => copyDetails(film(hash), film(hash).path).find((section) => section.title.startsWith(title))!.rows.map((row) => [row.text, row.note]);

	it('lists the file, the picture with its Dolby Vision fallback, and its bitrate', () => {
		const [file, video] = copyDetails(film('1eb31028de739d420ac9c00f74e5986e633f4236'), '');
		expect(file.rows.map((row) => row.text)).toEqual(['Severance.S02E06.Attila.2160p.ATVP.WEB.DL.DDP5.1.Atmos.DV.H.265-Kitsune.mkv', '8.4 GB · 48 min · MKV · 24.8 Mb/s']);
		expect(video.rows.map((row) => row.text)).toEqual(['HEVC Main 10 · 3840×1606 · 23.976 fps · 10-bit', 'Dolby Vision profile 5, Dolby Vision screens only', '24.0 Mb/s']);
		expect(copyDetails(film('225956129403e3d923980a34dfd17ffbe2dd0f9a'), '')[1].rows[1].text).toBe('Dolby Vision profile 8.1, HDR10 for other screens');
		expect(copyDetails(film('4a41f9f4f273a0b3ba1587456d60ef620adc35cc'), '')[1].rows[1].text).toBe('HLG');
	});

	it('says when the dynamic range came from the name', () => {
		const probe = { ...film('2967018e386b79cacdec0a892247bd7bea93fc30') };
		probe.video = { ...probe.video!, transfer: undefined };
		expect(copyDetails(probe, 'X.2160p.HDR10Plus')[1].rows[1]).toEqual({ text: 'HDR10+', note: 'from the release name' });
		// the probe's Dolby Vision and HDR10 base layer, the name's +
		expect(copyDetails(film('69c97601dec7d1c3e9b1ce9f288fc898dacffb25'), 'Lilo.and.Stitch.2025.Hybrid.HDR10+.DV7.Atmos.Remux.2160p.mkv')[1].rows[1]).toEqual({ text: 'Dolby Vision profile 7.6, HDR10+ for other screens', note: 'HDR10+ from the release name' });
	});

	it('lists every audio track with language, codec, channels and the default', () => {
		expect(texts('ed66d20f2c6c53b772d7bfe4b8171d84afd0175b', 'Audio')).toEqual([
			['English · DTS-HD MA 5.1 · Default', undefined],
			['Spanish · DD 2.0', undefined],
		]);
	});

	it('lists PGS, ASS and SRT subtitles with their forced, default and SDH flags', () => {
		const heist = texts('ed66d20f2c6c53b772d7bfe4b8171d84afd0175b', 'Subtitles');
		expect(heist.slice(0, 3)).toEqual([
			['English · PGS · Default', 'English-PGS'],
			['Spanish · PGS', 'Spanish-PGS'],
			['Spanish · PGS', 'Spanish-FORCED-PGS'],
		]);
		expect(texts('21d270b6110cdc2d8cba313a1185f48e10be9604', 'Subtitles').filter(([text]) => text!.includes('Forced')).length).toBeGreaterThan(0);
		expect(texts('21d270b6110cdc2d8cba313a1185f48e10be9604', 'Subtitles')[0][0]).toMatch(/^English · ASS/);
		expect(texts('025b41474869f9cfd05bbf2712f3d6d004aeff09', 'Subtitles').map(([text]) => text)).toEqual(['French · SRT · Default · Forced', 'French · SRT · SDH']);
	});
});

describe('matching probes to files', () => {
	const sightingsProbes = releaseProbes(releases[sightings.hash]);
	const rdFiles = sightings.files.map((file) => ({ id: String(file.id), name: file.path, size: file.bytes, selected: file.selected === 1 }));
	const item = { id: 'rd:QP76YYG2XC6P2', provider: 'rd', hash: sightings.hash, filename: sightings.filename, status: 'finished' } as LibraryItem;

	it("matches a season pack's episodes file by file, double episode included, and leaves the rest without", () => {
		const episodes = showEpisodes([{ item, files: rdFiles }]);
		const matched = [...episodes.seasons.values()].flatMap((season) => [...season.values()].flat()).filter((copy) => probeFor(sightingsProbes, copy.file));
		expect(matched.map((copy) => copy.file.name).sort()).toEqual(['/Sightings - 1x01 - The UFO Report.mp4', '/Sightings - 1x02 - Ghosts.mp4', '/Sightings - 1x06-07 - Mysteries of the Earth & UFO Contact.mp4', '/Sightings - 2x15 - Ghost Writer.mp4']);
		expect(probeFor(sightingsProbes, rdFiles.find((file) => file.name.includes('1x07 - UFO'))!)).toBeUndefined();
	});

	it("finds a file another provider lists under its own folders by size, and by name when it has no size", () => {
		const probe = sightingsProbes.find((p) => p.path.includes('1x02'))!;
		expect(probeFor(sightingsProbes, { name: 'Sightings/Sightings - 1x02 - Ghosts.mp4', size: 176880211 })).toBe(probe);
		expect(probeFor(sightingsProbes, { name: 'Sightings - 1x02 - Ghosts.mp4', path: 'Sightings', size: 0 })).toBe(probe);
		// a size no probe has is another file, whatever its name
		expect(probeFor(sightingsProbes, { name: 'Sightings - 1x02 - Ghosts.mp4', size: 123 })).toBeUndefined();
	});

	it('takes a film copy as its largest probed file only when that is most of the release', () => {
		const heist = releaseProbes(releases.ed66d20f2c6c53b772d7bfe4b8171d84afd0175b);
		expect(filmProbe(heist, heist[0].bytes + 1000)).toBe(heist[0]);
		expect(filmProbe(heist, heist[0].bytes * 10)).toBeUndefined();
		expect(filmProbe([], 1)).toBeUndefined();
	});
});

describe('labels', () => {
	it('names languages by either ISO 639-2 code or the word, and leaves none for und/zxx', () => {
		expect(['fre', 'fra', 'ger', 'deu', 'english', 'jpn', 'ukr'].map(languageName)).toEqual(['French', 'French', 'German', 'German', 'English', 'Japanese', 'Ukrainian']);
		expect(['jpn', 'chi', 'enm', 'und', 'zxx', undefined].map(languageCode)).toEqual(['JA', 'ZH', 'ENM', undefined, undefined, undefined]);
		expect([languageName('und'), languageName('zxx'), languageName('arc')]).toEqual(['Unknown language', 'No language', 'ARC']);
	});

	it("reads channels as DMM does, the layout's own number first", () => {
		expect([channelLabel({ channels: 6, layout: '5.1(side)' }), channelLabel({ channels: 7, layout: '6.1(back)' }), channelLabel({ channels: 8 }), channelLabel({ channels: 2, layout: 'stereo' }), channelLabel({ channels: 3 })]).toEqual(['5.1', '6.1', '7.1', '2.0', '3.0']);
	});
});

const json = (status: number, body: unknown) => ({ status, ok: status >= 200 && status < 300, headers: { get: () => null }, json: async () => body });
const memoryStore = (): CacheStore & { text: string | null } => {
	const store = { text: null as string | null, read: async () => store.text, write: async (text: string) => void (store.text = text) };
	return store;
};
const PM = { service: 'pm' as const, apiKey: 'pm-test' };
const AD = { service: 'ad' as const, apiKey: 'ad-test' };
const row = (hash: string, provider: LibraryItem['provider'] = 'rd'): LibraryItem => ({ id: `${provider}:${hash.slice(0, 6)}`, provider, hash, filename: 'x', title: 'x', size: 1, progress: 100, status: 'finished', added: '' }) as LibraryItem;
const [JUMANJI, ABBOTT] = live.request.hashes;

describe('askProbes', () => {
	it('posts batches of 100 hashes with the login and answers each hash, empty for no probe', async () => {
		const calls: { url: string; body: { hashes: string[]; identity: unknown } }[] = [];
		const hashes = [JUMANJI, ABBOTT, ...Array.from({ length: 150 }, (_, n) => n.toString(16).padStart(40, '0'))];
		const post: Post = async (url, body) => {
			calls.push({ url, body: body as (typeof calls)[number]['body'] });
			return json(200, live.body);
		};
		const answers = new Map<string, FileProbe[]>();
		await askProbes(hashes, PM, (batch) => batch.forEach((files, hash) => answers.set(hash, files)), post);
		expect(calls.map((call) => [call.url, call.body.hashes.length, call.body.identity])).toEqual([
			['https://debridmediamanager.com/api/library/mediainfo', 100, PM],
			['https://debridmediamanager.com/api/library/mediainfo', 52, PM],
		]);
		expect(answers.get(JUMANJI)!.map((file) => file.path)).toEqual(['/Jumanji.Welcome.to.the.Jungle.2017.2160p.UHDRemux.HYBRID.HDR.DV-TheEqualizer.mkv']);
		expect(answers.get(ABBOTT)).toEqual([]);
	});

	it('throws LoginRefused on the 403 DMM answers a login it cannot verify, and stops on a 429', async () => {
		await expect(askProbes([JUMANJI], PM, vi.fn(), async () => json(403, { error: 'This endpoint serves DMM pages only.' }))).rejects.toBeInstanceOf(LoginRefused);
		const onAnswer = vi.fn();
		await askProbes([JUMANJI], PM, onAnswer, async () => json(429, {}));
		expect(onAnswer).not.toHaveBeenCalled();
	});
});

describe('TitleIndex probes', () => {
	it('asks only for releases not kept, keeps the answer across launches, and the next login after a refused one', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout'] });
		const post = vi.fn<Post>(async (_, body) => ((body as { identity: unknown }).identity === PM ? json(403, {}) : json(200, live.body)));
		const store = memoryStore();
		const index = new TitleIndex({ identities: () => [PM, AD], detail: vi.fn() }, store, post);
		// Premiumize and Offcloud copies can have no hash
		const items = [row(JUMANJI), row(ABBOTT, 'ad'), row(JUMANJI.toUpperCase(), 'tb'), row('', 'pm')];
		await index.loadProbes(items);
		expect(post.mock.calls.map(([, body]) => body)).toEqual([
			{ hashes: [JUMANJI, ABBOTT], identity: PM },
			{ hashes: [JUMANJI, ABBOTT], identity: AD },
		]);
		expect(index.probesOf(row(JUMANJI.toUpperCase()))?.[0].video?.dv).toEqual({ profile: 8, compat: 1 });
		expect(index.probesOf(row(ABBOTT))).toEqual([]);
		await vi.runAllTimersAsync();
		vi.useRealTimers();

		const again = new TitleIndex({ identities: () => [AD], detail: vi.fn() }, store, post);
		await again.loadProbes(items);
		expect(post).toHaveBeenCalledTimes(2);
		expect(again.probesOf(row(JUMANJI))?.[0].audio[0].codec).toBe('truehd');
	});

	// On the Pixel 6 (2026-11-13) a real Real-Debrid copy of Sintel showed no probe: the demo library uses the
	// Blender torrents' hashes, and the app skipped every copy with a demo hash. Demo copies are archive.org files,
	// so they are left out by their demo-key provider, and a real copy of the same torrent gets its probe.
	it("describes a real copy of a torrent the demo library also lists, never the demo key's copy", async () => {
		const SINTEL = '08ada5a7a6183aae1e09d831df6748d566095a10';
		const post = vi.fn<Post>(async (_, body) => json(200, { releases: Object.fromEntries((body as { hashes: string[] }).hashes.map((hash) => [hash, releases[hash]]).filter(([, release]) => release)) }));
		const index = new TitleIndex({ identities: () => [PM], detail: vi.fn(), isDemo: (provider) => provider === 'tb' }, memoryStore(), post);
		await index.loadProbes([row(SINTEL, 'rd'), row(SINTEL, 'tb')]);
		await index.loadProbes([row('209c8226b299b308beaf2b9cd3fb49212dbd13ec', 'tb')]);
		expect(post.mock.calls.map(([, body]) => (body as { hashes: string[] }).hashes)).toEqual([[SINTEL]]);
		expect(copyFacts(filmProbe(index.probesOf(row(SINTEL, 'rd'))!, 129302391)!, 'Sintel.mp4').picture).toEqual(['SD', 'H264']);
		expect(index.probesOf(row(SINTEL, 'tb'))).toBeUndefined();
	});

	it('asks again about a release with no probe after a week, one with probes after a month', async () => {
		let now = Date.parse('2026-11-13T00:00:00Z');
		const post = vi.fn<Post>(async () => json(200, live.body));
		const index = new TitleIndex({ identities: () => [PM], detail: vi.fn() }, memoryStore(), post, undefined, () => now);
		await index.loadProbes([row(JUMANJI), row(ABBOTT)]);
		now += 8 * 24 * 3600 * 1000;
		await index.loadProbes([row(JUMANJI), row(ABBOTT)]);
		now += 6 * 24 * 3600 * 1000;
		await index.loadProbes([row(JUMANJI), row(ABBOTT)]);
		now += 17 * 24 * 3600 * 1000;
		await index.loadProbes([row(JUMANJI), row(ABBOTT)]);
		expect(post.mock.calls.map(([, body]) => (body as { hashes: string[] }).hashes)).toEqual([[JUMANJI, ABBOTT], [ABBOTT], [JUMANJI, ABBOTT]]);
	});

	it('leaves releases unasked when DMM is rate limited, so the page asks again', async () => {
		const post = vi.fn<Post>(async () => json(429, {}));
		const index = new TitleIndex({ identities: () => [PM], detail: vi.fn() }, memoryStore(), post);
		await index.loadProbes([row(JUMANJI)]);
		await index.loadProbes([row(JUMANJI)]);
		expect(post).toHaveBeenCalledTimes(2);
		expect(index.probesOf(row(JUMANJI))).toBeUndefined();
	});
});
