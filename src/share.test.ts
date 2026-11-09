import lzString from 'lz-string';
import { describe, expect, it } from 'vitest';
import type { LibraryItem } from './model';
import { runBulk } from './core';
import { backupJson, hashlistUrl, parseAddInput, parseBackup } from './share';

const HASH = '0123456789abcdef0123456789abcdef01234567';
const row = (overrides: Partial<LibraryItem>): LibraryItem => ({
	id: 'rd:1', provider: 'rd', title: 'Sintel', filename: 'Sintel.2010.mkv', hash: HASH, size: 42, progress: 100,
	status: 'finished', serviceStatus: 'downloaded', added: '2026-01-01T00:00:00Z', files: [], ...overrides,
});

describe('sharing and backups', () => {
	it('writes a hash list DMM web /hashlist decodes, leaving out hashless and web-download rows', () => {
		const url = hashlistUrl('Mine', [row({}), row({ id: 'tb:w:1', kind: 'web', hash: 'e'.repeat(32) }), row({ id: 'pm:t:2', hash: '' })]);
		expect(url.startsWith('https://debridmediamanager.com/hashlist#')).toBe(true);
		const list = JSON.parse(lzString.decompressFromEncodedURIComponent(url.split('#')[1]) ?? '');
		expect(list).toEqual({ title: 'Mine', torrents: [{ filename: 'Sintel.2010.mkv', hash: HASH, bytes: 42 }] });
	});

	it('round-trips the .dmm.json backup DMM web writes', () => {
		// DMM web's localBackup: JSON.stringify([{ filename, hash }], null, 2)
		const web = JSON.stringify([{ filename: 'A', hash: HASH.toUpperCase() }, { filename: 'B', hash: 'nope' }, { filename: 'C', hash: HASH }], null, 2);
		expect(parseBackup(web)).toEqual([HASH]);
		expect(parseBackup(backupJson([row({})]))).toEqual([HASH]);
		expect(() => parseBackup('{"x":1}')).toThrow(/backup/);
		expect(() => parseBackup('not json')).toThrow(/backup/);
	});

	it('reads magnets, bare hashes and web links, one per line, dropping repeats and reporting junk', () => {
		const { entries, invalid } = parseAddInput(`magnet:?xt=urn:btih:${HASH}&dn=Sintel\n${HASH.toUpperCase()}\n${'b'.repeat(40)}  https://example.com/a.mkv\nhello`);
		expect(entries).toEqual([
			{ kind: 'magnet', magnet: `magnet:?xt=urn:btih:${HASH}&dn=Sintel`, hash: HASH },
			{ kind: 'hash', hash: 'b'.repeat(40) },
			{ kind: 'url', url: 'https://example.com/a.mkv' },
		]);
		expect(invalid).toEqual(['hello']);
	});

	it('runs bulk work four at a time and reports each failure', async () => {
		let running = 0;
		let peak = 0;
		const progress: number[] = [];
		const result = await runBulk(
			[1, 2, 3, 4, 5, 6, 7],
			async (n) => {
				running++;
				peak = Math.max(peak, running);
				await new Promise((resolve) => setTimeout(resolve, 5));
				running--;
				if (n === 3) throw new Error('refused');
			},
			(n) => `item ${n}`,
			(finished) => progress.push(finished)
		);
		expect(peak).toBe(4);
		expect(result).toEqual({ done: 6, failed: [{ label: 'item 3', message: 'refused' }] });
		expect(progress).toEqual([1, 2, 3, 4, 5, 6, 7]);
	});
});
