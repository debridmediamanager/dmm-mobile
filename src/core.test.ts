import { describe, expect, it } from 'vitest';
import { duplicatesToDelete, EMPTY_QUERY, filterAndSortLibrary, groupLibrary, mediaTypeOf, sameHashMergeGroups, titleKeyOf, transferItems, type LibraryQuery } from './core';
import type { LibraryItem } from './model';
import { _testing } from './providerApi';
import { isSafeExternalUrl, magnetForHash, parseBtihMagnet } from './validation';

const HASH = '0123456789abcdef0123456789abcdef01234567';

const item = (overrides: Partial<LibraryItem>): LibraryItem => ({
	id: 'rd:1',
	provider: 'rd',
	title: 'A Movie',
	filename: 'A.Movie.2024.mkv',
	hash: HASH,
	size: 100,
	progress: 100,
	status: 'finished',
	serviceStatus: 'downloaded',
	added: '2026-01-02T00:00:00.000Z',
	files: [],
	...overrides,
});

describe('magnet and library boundaries', () => {
	it('accepts a v1 BTIH, preserves useful magnet parameters, and normalizes hash case', () => {
		const parsed = parseBtihMagnet(`magnet:?dn=Movie&xt=urn:btih:${HASH.toUpperCase()}`);
		expect(parsed.hash).toBe(HASH);
		expect(parsed.magnet).toBe(`magnet:?xt=urn:btih:${HASH}&dn=Movie`);
	});

	it('rejects v2-only, malformed, and non-magnet sources', () => {
		expect(() => parseBtihMagnet('https://example.test/file.torrent')).toThrow(/magnet/i);
		expect(() => parseBtihMagnet('magnet:?xt=urn:btmh:1220abcd')).toThrow(/BTIH/i);
		expect(() => parseBtihMagnet('magnet:?xt=urn:btih:bad')).toThrow(/BTIH/i);
	});

	it('builds a shareable magnet without exposing a provider URL', () => {
		expect(magnetForHash(HASH, 'A Movie')).toBe(`magnet:?xt=urn:btih:${HASH}&dn=A+Movie`);
	});

	it('searches title and filename, filters provider and view, and sorts requested fields', () => {
		const rows = [
			item({ id: 'rd:1', title: 'Zulu', size: 100, added: '2026-01-01T00:00:00Z' }),
			item({ id: 'tb:2', provider: 'tb', title: 'Alpha', size: 300, progress: 20, status: 'downloading', added: '2026-01-03T00:00:00Z' }),
			item({ id: 'pm:3', provider: 'pm', title: 'Bravo', filename: 'hidden-search-name', size: 200, progress: 0, status: 'error' }),
		];
		const ids = (query: Partial<LibraryQuery>) => filterAndSortLibrary(rows, { ...EMPTY_QUERY, ...query }).map((row) => row.id);
		expect(ids({ search: 'hidden-search' })).toEqual(['pm:3']);
		expect(ids({ provider: 'tb', view: 'inprogress', sort: 'title' })).toEqual(['tb:2']);
		expect(ids({ view: 'failed' })).toEqual(['pm:3']);
		expect(ids({ sort: 'size' })).toEqual(['tb:2', 'pm:3', 'rd:1']);
		expect(ids({ sort: 'progress' })).toEqual(['pm:3', 'tb:2', 'rd:1']);
		expect(ids({ sort: 'oldest' })[0]).toBe('rd:1');
	});

	it('matches every search word, as a regex, id, provider prefix, hash or provider status', () => {
		const rows = [
			item({ id: 'rd:ABC123', filename: 'Big.Buck.Bunny.2008.1080p.mkv', serviceStatus: 'downloaded' }),
			item({ id: 'ad:9', provider: 'ad', filename: 'Sintel.2010.720p.mkv', hash: 'b'.repeat(40), serviceStatus: 'Ready' }),
		];
		const ids = (search: string) => filterAndSortLibrary(rows, { ...EMPTY_QUERY, search }).map((row) => row.id);
		expect(ids('bunny 1080p')).toEqual(['rd:ABC123']);
		expect(ids('bunny 720p')).toEqual([]);
		expect(ids('sintel|bunny').sort()).toEqual(['ad:9', 'rd:ABC123']);
		expect(ids('abc123')).toEqual(['rd:ABC123']);
		expect(ids('ad:')).toEqual(['ad:9']);
		expect(ids('b'.repeat(40))).toEqual(['ad:9']);
		expect(ids('ready')).toEqual(['ad:9']);
		expect(ids('[')).toEqual([]);
	});

	it('guesses media type from the name as DMM web does, and calls a videoless pack other', () => {
		expect(mediaTypeOf(item({ filename: 'Show.Name.S01E02.1080p.mkv' }))).toBe('tv');
		expect(mediaTypeOf(item({ filename: 'Show Name Season 2 Complete' }))).toBe('tv');
		expect(mediaTypeOf(item({ filename: 'Tears.of.Steel.2012.1080p.mkv' }))).toBe('movie');
		expect(mediaTypeOf(item({ filename: 'Album.2020.FLAC', files: [{ id: '1', name: '01.flac', size: 1 }] }))).toBe('other');
		const rows = [item({ id: 'rd:1', filename: 'Show.S01E01.mkv' }), item({ id: 'rd:2', filename: 'Film.2001.mkv' })];
		expect(filterAndSortLibrary(rows, { ...EMPTY_QUERY, media: 'tv' }).map((row) => row.id)).toEqual(['rd:1']);
	});

	it('groups same hash per provider and same title across releases, counting bytes once per hash', () => {
		const rows = [
			item({ id: 'rd:1', filename: 'Sintel.2010.1080p.WEB.mkv', size: 10 }),
			item({ id: 'rd:2', filename: 'Sintel.2010.720p.BluRay.mkv', hash: 'c'.repeat(40), size: 5 }),
			item({ id: 'rd:3', filename: 'Sintel.2010.1080p.WEB.mkv', size: 10 }),
			item({ id: 'pm:4', provider: 'pm', filename: 'Sintel.2010.1080p.WEB.mkv', size: 10 }),
			item({ id: 'rd:5', filename: 'Elephants.Dream.2006.mkv', hash: 'd'.repeat(40), size: 1 }),
		];
		const grouping = groupLibrary(rows);
		expect(grouping.totalBytes).toBe(26);
		const view = (v: LibraryQuery['view']) => filterAndSortLibrary(rows, { ...EMPTY_QUERY, view: v }, grouping).map((row) => row.id).sort();
		expect(view('samehash')).toEqual(['rd:1', 'rd:3']);
		expect(view('sametitle')).toEqual(['pm:4', 'rd:1', 'rd:2', 'rd:3']);
		expect(filterAndSortLibrary(rows, { ...EMPTY_QUERY, titleKey: titleKeyOf(rows[4]) }).map((row) => row.id)).toEqual(['rd:5']);
	});

	it('filters slow, uncached, RD-blocked and selected rows as DMM web does', () => {
		const now = Date.parse('2026-11-09T12:00:00Z');
		const rows = [
			item({ id: 'rd:slow', status: 'downloading', seeders: 0, added: '2026-11-09T11:00:00Z' }),
			item({ id: 'rd:young', status: 'downloading', seeders: 0, added: '2026-11-09T11:50:00Z' }),
			item({ id: 'tb:w:web', provider: 'tb', kind: 'web', status: 'downloading', seeders: 0, added: '2026-11-09T10:00:00Z' }),
			item({ id: 'rd:gone', uncached: true }),
			item({ id: 'rd:blocked', filename: 'Movie.2020.1080p.WEB-DL.mkv' }),
			item({ id: 'pm:blocked', provider: 'pm', filename: 'Movie.2020.1080p.WEB-DL.mkv' }),
			item({ id: 'rd:scene', filename: 'Movie.2020.1080p.WEB.h264-GRP.mkv' }),
		];
		const view = (v: LibraryQuery['view'], selected?: Set<string>) => filterAndSortLibrary(rows, { ...EMPTY_QUERY, view: v, selected }, undefined, now).map((row) => row.id);
		expect(view('slow')).toEqual(['rd:slow']);
		expect(view('uncached')).toEqual(['rd:gone']);
		expect(view('rdblocked')).toEqual(['rd:blocked']);
		expect(view('selected', new Set(['rd:gone']))).toEqual(['rd:gone']);
	});

	it('keys a TV title by show, season and episode as DMM web does, so episodes are not one title', () => {
		// Names from the shared TorBox library on the Pixel 6, 2026-11-09.
		const rows = [
			item({ id: 'tb:1', provider: 'tb', filename: 'Gilmore Girls S03E09 A Deep Fried Korean Thanksgiving 1080p BluRay Remux FLAC2 0 H 264-NTb' }),
			item({ id: 'tb:2', provider: 'tb', filename: 'Gilmore Girls S03E02 Haunted Leg 1080p BluRay Remux FLAC2 0 H 264-NTb' }),
			item({ id: 'tb:3', provider: 'tb', filename: 'Gilmore.Girls.S03E02.720p.WEB.h264-OTHER' }),
			item({ id: 'tb:4', provider: 'tb', filename: 'Gilmore Girls Season 3 Complete 1080p' }),
			item({ id: 'tb:5', provider: 'tb', filename: 'Gilmore.Girls.S03.1080p.BluRay' }),
		];
		expect(filterAndSortLibrary(rows, { ...EMPTY_QUERY, view: 'sametitle' }).map((row) => row.id).sort()).toEqual(['tb:2', 'tb:3', 'tb:4', 'tb:5']);
	});

	it('filters, groups and searches 5,000 rows quickly enough to run on every keystroke', () => {
		const rows = Array.from({ length: 5000 }, (_, n) => item({ id: `tb:${n}`, provider: 'tb', filename: `Show.${n % 300}.S0${n % 9}E${n % 20}.1080p.WEB.mkv`, hash: n.toString(16).padStart(40, '0'), size: n, added: new Date(n * 1000).toISOString() }));
		const started = performance.now();
		const grouping = groupLibrary(rows);
		for (const search of ['s', 'sh', 'show', 'show 1', 'show 1 1080p']) filterAndSortLibrary(rows, { ...EMPTY_QUERY, search, view: 'sametitle', sort: 'title' }, grouping);
		expect(performance.now() - started).toBeLessThan(1500);
	});

	it('picks duplicates to delete by size or date and keeps one per title', () => {
		const rows = [
			item({ id: 'rd:small', filename: 'Sintel.2010.720p.mkv', size: 1, added: '2026-01-03T00:00:00Z' }),
			item({ id: 'rd:big', filename: 'Sintel.2010.2160p.mkv', size: 9, added: '2026-01-01T00:00:00Z' }),
			item({ id: 'rd:mid', filename: 'Sintel.2010.1080p.mkv', size: 5, added: '2026-01-02T00:00:00Z' }),
			item({ id: 'rd:only', filename: 'Cosmos.Laundromat.2015.mkv', size: 3 }),
		];
		const ids = (rule: Parameters<typeof duplicatesToDelete>[1]) => duplicatesToDelete(rows, rule).map((row) => row.id).sort();
		expect(ids('smaller')).toEqual(['rd:mid', 'rd:small']);
		expect(ids('bigger')).toEqual(['rd:big', 'rd:mid']);
		expect(ids('older')).toEqual(['rd:big', 'rd:mid']);
		expect(ids('newer')).toEqual(['rd:mid', 'rd:small']);
	});

	it('merges only finished rows that share a hash on the same provider', () => {
		const rows = [
			item({ id: 'rd:1' }),
			item({ id: 'rd:2' }),
			item({ id: 'rd:3', status: 'downloading' }),
			item({ id: 'ad:4', provider: 'ad' }),
		];
		expect(sameHashMergeGroups(rows).map((group) => group.map((row) => row.id))).toEqual([['rd:1', 'rd:2']]);
	});

	it('transfers is a view of actual non-finished statuses', () => {
		const rows = [item({ id: 'rd:1' }), item({ id: 'rd:2', status: 'waiting' }), item({ id: 'rd:3', status: 'downloading' }), item({ id: 'rd:4', status: 'error' })];
		expect(transferItems(rows).map((row) => row.id)).toEqual(['rd:2', 'rd:3', 'rd:4']);
	});
});

describe('provider normalization', () => {
	it('maps all six providers to safe library rows and preserves file identity', () => {
		expect(_testing.normalizeRd({ id: '1', filename: 'rd.mkv', hash: HASH, bytes: 10, progress: 20, status: 'downloading', added: '2026-01-01' }).provider).toBe('rd');
		expect(_testing.normalizeAd({ id: 2, filename: 'ad.mkv', hash: HASH, size: 20, statusCode: 4, uploadDate: 1, links: [{ filename: 'ad.mkv', size: 20, link: 'https://ad.example/file' }] }).files[0].name).toBe('ad.mkv');
		expect(_testing.normalizeTorBox({ id: 3, name: 'tb.mkv', hash: HASH, size: 30, progress: 1, download_finished: true, download_present: true, download_state: 'seeding', created_at: '2026-01-01', files: [{ id: 7, name: 'tb.mkv', size: 30 }] }, 'torrent').files[0].id).toBe('7');
		expect(_testing.buildPremiumizeItems([], [{ id: 'folder-1', name: 'Folder', type: 'folder' }], [{ id: 'file-1', name: 'movie.mkv', type: 'file', path: 'Folder/movie.mkv', size: 40, created_at: 1 }])[0].id).toBe('pm:f:folder-1');
		expect(_testing.normalizeOffcloud({ requestId: 'oc-1', fileName: 'oc.mkv', status: 'downloaded', createdOn: '2026-01-01' }).id).toBe('oc:oc-1');
		const debridLinkRow = _testing.normalizeDebridLink({ id: 'dl-1', name: 'dl.mkv', created: 1, hashString: HASH, status: 100, totalSize: 50, downloadPercent: 100, files: [{ id: 'file-1', name: 'dl.mkv', size: 50, downloadUrl: 'https://dl.example/file' }] });
		expect(debridLinkRow.files[0].id).toBe('file-1');
		expect(debridLinkRow.files[0].link).toBeUndefined();
	});

	it('flattens nested AllDebrid file trees without losing path mapping', () => {
		expect(_testing.flattenAdFiles([{ n: 'Season 1', e: [{ n: 'Episode.mkv', s: 10, l: 'https://ad.example/file' }] }])).toEqual([{ id: 'Season 1/Episode.mkv', name: 'Season 1/Episode.mkv', size: 10, link: 'https://ad.example/file' }]);
	});

	it('allows only HTTP(S) provider handoff URLs', () => {
		expect(isSafeExternalUrl('https://cdn.example/file.mkv')).toBe(true);
		expect(isSafeExternalUrl('http://cdn.example/file.mkv')).toBe(true);
		expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false);
		expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false);
	});
});
