import { describe, expect, it } from 'vitest';
import { filterAndSortLibrary, transferItems } from './core';
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
		expect(parsed.magnet).toContain('xt=urn%3Abtih%3A' + HASH);
		expect(parsed.magnet).toContain('dn=Movie');
	});

	it('rejects v2-only, malformed, and non-magnet sources', () => {
		expect(() => parseBtihMagnet('https://example.test/file.torrent')).toThrow(/magnet/i);
		expect(() => parseBtihMagnet('magnet:?xt=urn:btmh:1220abcd')).toThrow(/BTIH/i);
		expect(() => parseBtihMagnet('magnet:?xt=urn:btih:bad')).toThrow(/BTIH/i);
	});

	it('builds a shareable magnet without exposing a provider URL', () => {
		expect(magnetForHash(HASH, 'A Movie')).toContain('urn%3Abtih%3A' + HASH);
	});

	it('searches title and filename, filters provider/status, and sorts requested fields', () => {
		const rows = [
			item({ id: 'rd:1', title: 'Zulu', size: 100, added: '2026-01-01T00:00:00Z' }),
			item({ id: 'tb:2', provider: 'tb', title: 'Alpha', size: 300, status: 'downloading', added: '2026-01-03T00:00:00Z' }),
			item({ id: 'pm:3', provider: 'pm', title: 'Bravo', filename: 'hidden-search-name', size: 200, status: 'error' }),
		];
		expect(filterAndSortLibrary(rows, { search: 'hidden-search', provider: 'all', status: 'all', sort: 'newest' }).map((row) => row.id)).toEqual(['pm:3']);
		expect(filterAndSortLibrary(rows, { search: '', provider: 'tb', status: 'downloading', sort: 'title' }).map((row) => row.id)).toEqual(['tb:2']);
		expect(filterAndSortLibrary(rows, { search: '', provider: 'all', status: 'all', sort: 'size' }).map((row) => row.id)).toEqual(['tb:2', 'pm:3', 'rd:1']);
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
