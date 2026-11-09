import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	_testing,
	addMagnet,
	addTorrentFile,
	getLibraryDetail,
	listLibrary,
	ProviderApiError,
	reinsertItem,
	resolveFile,
	validateCredential,
} from './providerApi';
import rdMovie from './test/fixtures/rdinfo_movie.json';
import rdTv from './test/fixtures/rdinfo_tv.json';
import rdLinksByLimit from './test/fixtures/rd-torrents-links-by-limit-2026-11-09.json';
import type { LibraryItem } from './model';
import rdFixture from './test/fixtures/rd-bdmv-single-selection-2026-10-12.json';
import adFilesFixture from './test/fixtures/adfiles.json';
import adStatusFixture from './test/fixtures/adstatus.json';
import rdArchived from './test/fixtures/rd-info-archived-selection-2026-11-09.json';
import rdEncodedXt from './test/fixtures/rd-addmagnet-encoded-xt-2026-11-09.json';
import { parseBtihMagnet } from './validation';
import tbFreePlan from './test/fixtures/tb-user-me-free-plan-2026-11-09.json';

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

afterEach(() => vi.unstubAllGlobals());

describe('provider API envelopes and pagination', () => {
	it('walks every Real-Debrid page advertised by x-total-count', async () => {
		const fetchMock = vi.fn((url: string) => {
			const page = new URL(url).searchParams.get('page');
			return Promise.resolve(jsonResponse(
				page === '1'
					? [{ id: '1', filename: 'one.mkv', hash: 'a'.repeat(40), bytes: 1, progress: 100, status: 'downloaded', added: '2026-01-01' }]
					: [{ id: '2', filename: 'two.mkv', hash: 'b'.repeat(40), bytes: 2, progress: 100, status: 'downloaded', added: '2026-01-02' }],
				200,
				{ 'x-total-count': '2' }
			));
		});
		vi.stubGlobal('fetch', fetchMock);
		const rows = await listLibrary('rd', 'secret-token');
		expect(rows).toHaveLength(2);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(String(fetchMock.mock.calls[0]?.[0] ?? '')).not.toContain('secret-token');
	});

	it('treats TorBox success:false at HTTP 200 as a provider failure', async () => {
		vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ success: false, error: 'plan restricted' }))));
		await expect(listLibrary('tb', 'secret-token')).rejects.toMatchObject({ code: 'business_error' });
	});

	it('fails the TorBox library as a whole when one subtype cannot be read', async () => {
		vi.stubGlobal('fetch', vi.fn((url: string) => {
			if (url.includes('/webdl/mylist')) return Promise.resolve(jsonResponse({ success: false, error: 'web disabled' }));
			return Promise.resolve(jsonResponse({ success: true, data: [{ id: 1, name: 'partial', download_finished: true, download_present: true, files: [] }] }));
		}));
		await expect(listLibrary('tb', 'secret-token')).rejects.toMatchObject({ provider: 'tb' });
	});

	it('rejects a malformed Real-Debrid list response instead of erasing the library', async () => {
		vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({}))))
		await expect(listLibrary('rd', 'secret-token')).rejects.toMatchObject({ code: 'invalid_response' });
	});

	it('does not retain AllDebrid direct links while listing a library', async () => {
		vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({
			status: 'success',
			data: { magnets: [{ id: 1, filename: 'movie.mkv', statusCode: 4, links: [{ filename: 'movie.mkv', size: 12, link: 'https://ad.example/signed' }] }] },
		}))));
		const rows = await listLibrary('ad', 'secret-token');
		expect(rows[0]?.files[0]?.link).toBeUndefined();
	});

	it('validates account credentials with read-only requests and reports bad HTTP auth', async () => {
		const fetchMock = vi.fn((..._args: unknown[]) => Promise.resolve(jsonResponse({ error: 'invalid token' }, 401)));
		vi.stubGlobal('fetch', fetchMock);
		await expect(validateCredential('dl', 'bad-token')).rejects.toBeInstanceOf(ProviderApiError);
		expect(String(fetchMock.mock.calls[0]?.[0] ?? '')).toContain('/account/infos');
		expect(String(fetchMock.mock.calls[0]?.[0] ?? '')).not.toContain('bad-token');
	});

	it('rejects invalid magnets before any provider mutation request', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		for (const provider of ['rd', 'ad', 'tb', 'pm', 'oc', 'dl'] as const) {
			await expect(addMagnet(provider, 'token', 'magnet:?xt=urn:btih:not-a-v1-hash')).rejects.toMatchObject({ code: 'invalid_magnet' });
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('does not hand out a Real-Debrid archive link as one of the files packed into it', async () => {
		// Nine files selected, one link back: Real-Debrid served them as Sintel.rar (2026-11-09).
		const files = _testing.rdFiles(rdArchived);
		expect(files.filter((file) => file.selected)).toHaveLength(9);
		expect(files.some((file) => file.link)).toBe(false);
		const fetchMock = vi.fn((url: string) => {
			if (url.includes('/torrents/info/')) return Promise.resolve(jsonResponse(rdArchived));
			throw new Error(`unexpected ${url}`);
		});
		vi.stubGlobal('fetch', fetchMock);
		const item = _testing.normalizeRd(rdArchived, files);
		const mp4 = files.find((file) => file.name === '/Sintel.mp4')!;
		await expect(resolveFile('rd', 'secret-token', item, mp4.id)).rejects.toMatchObject({ code: 'archived_selection' });
		const srt = files.find((file) => file.name === '/Sintel.de.srt')!;
		await expect(resolveFile('rd', 'secret-token', item, srt.id)).rejects.toMatchObject({ code: 'archived_selection' });
	});

	it('uses the selected-file cursor for Real-Debrid links', async () => {
		const recorded = rdFixture.info.RHYN5ZZJ6X6CI;
		const selected = (recorded.files as Array<Record<string, unknown>>)[0];
		const unselected = (recorded.files as Array<Record<string, unknown>>)[1];
		const row = {
			...recorded,
			files: [{ ...unselected, id: 99, selected: 0 }, selected],
			links: ['https://real-debrid.com/d/ABCDEFGHIJKLMXYZ'],
		};
		const item = _testing.normalizeRd(row, [
			{ id: '1', name: String(selected.path), size: Number(selected.bytes) },
		]);
		const fetchMock = vi.fn((url: string) => {
			if (url.includes('/torrents/info/')) return Promise.resolve(jsonResponse(row));
			if (url.endsWith('/unrestrict/link')) return Promise.resolve(jsonResponse({ download: 'https://cdn.example/movie.mkv' }));
			throw new Error(`unexpected ${url}`);
		});
		vi.stubGlobal('fetch', fetchMock);
		await expect(resolveFile('rd', 'secret-token', item, '1')).resolves.toBe('https://cdn.example/movie.mkv');
		const unrestrict = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>).find(([url]) => String(url).endsWith('/unrestrict/link'));
		expect(new URLSearchParams(String(unrestrict?.[1]?.body ?? '')).get('link')).toBe(
			'https://real-debrid.com/d/ABCDEFGHIJKLM'
		);
	});

	it('runs AllDebrid detail/files through link unlock', async () => {
		const status = { ...adStatusFixture, status: 'Ready' };
		const fetchMock = vi.fn((url: string) => {
			if (url.endsWith('/magnet/status')) return Promise.resolve(jsonResponse({ status: 'success', data: { magnets: [status] } }));
			if (url.endsWith('/magnet/files')) return Promise.resolve(jsonResponse(adFilesFixture));
			if (url.endsWith('/link/unlock')) return Promise.resolve(jsonResponse({ status: 'success', data: { link: 'https://cdn.example/breadwinner.mkv' } }));
			throw new Error(`unexpected ${url}`);
		});
		vi.stubGlobal('fetch', fetchMock);
		const item = await getLibraryDetail('ad', 'secret-token', `ad:${String(status.id)}`);
		const file = item.files.find((entry) => entry.name.endsWith('.mkv'));
		expect(file).toBeDefined();
		await expect(resolveFile('ad', 'secret-token', item, file!.id)).resolves.toBe('https://cdn.example/breadwinner.mkv');
		expect(fetchMock.mock.calls.map(([url]) => String(url))).toContain('https://api.alldebrid.com/v4.1/link/unlock');
	});

	it('surfaces an AllDebrid unlock envelope error', async () => {
		vi.stubGlobal('fetch', vi.fn((url: string) => {
			if (url.endsWith('/link/unlock')) return Promise.resolve(jsonResponse({ status: 'error', error: { code: 'LINK_HOST_NOT_SUPPORTED', message: 'unsupported host' } }));
			throw new Error(`unexpected ${url}`);
		}));
		const item: LibraryItem = {
			id: 'ad:1', provider: 'ad', title: 'movie', filename: 'movie', hash: '', size: 1,
			progress: 100, status: 'finished', serviceStatus: 'Ready', added: new Date(0).toISOString(),
			files: [{ id: 'movie.mkv', name: 'movie.mkv', size: 1, link: 'https://alldebrid.com/f/locked' }],
		};
		await expect(resolveFile('ad', 'secret-token', item, 'movie.mkv')).rejects.toMatchObject({ provider: 'ad' });
	});

	it('rejects a per-magnet AllDebrid upload error inside a successful envelope', async () => {
		vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({
			status: 'success',
			data: { magnets: [{ error: { code: 'MAGNET_INVALID', message: 'invalid magnet' } }] },
		}))));
		await expect(addMagnet('ad', 'secret-token', 'magnet:?xt=urn:btih:' + 'a'.repeat(40))).rejects.toMatchObject({ provider: 'ad' });
	});

	it('sends TorBox requestdl token and authorization for torrent, web, and usenet files', async () => {
		const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ success: true, data: 'https://cdn.example/file' })));
		vi.stubGlobal('fetch', fetchMock);
		const cases = [
			['tb:11', 'torrent_id'],
			['tb:w:22', 'web_id'],
			['tb:u:33', 'usenet_id'],
		] as const;
		for (const [id, key] of cases) {
			const item: LibraryItem = {
				id, provider: 'tb', title: id, filename: id, hash: '', size: 1, progress: 100,
				status: 'finished', serviceStatus: 'completed', added: new Date(0).toISOString(),
				files: [{ id: '7', name: 'file.mkv', size: 1 }],
			};
			await expect(resolveFile('tb', 'secret-token', item, '7')).resolves.toBe('https://cdn.example/file');
			const [url, init] = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>).at(-1)!;
			const parsed = new URL(String(url));
			expect(parsed.searchParams.get('token')).toBe('secret-token');
			expect(parsed.searchParams.get(key)).toBe(id.split(':').at(-1));
			expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer secret-token' });
		}
	});

	it('does not treat one-percent Debrid-Link progress as complete', () => {
		const item = _testing.normalizeDebridLink({
			id: 'dl-1', name: 'one-percent', created: 1, hashString: 'a'.repeat(40), status: 4,
			totalSize: 100, downloadPercent: 1, files: [],
		});
		expect(item.status).toBe('downloading');
		expect(item.progress).toBe(1);
	});

	it('uses both Debrid-Link id filters and follows an advancing short page', async () => {
		const fetchMock = vi.fn((url: string) => {
			const parsed = new URL(url);
			if (parsed.pathname.endsWith('/seedbox/list') && parsed.searchParams.has('id')) {
				expect(parsed.searchParams.get('id')).toBe('wanted');
				expect(parsed.searchParams.get('ids')).toBe('wanted');
				return Promise.resolve(jsonResponse({ success: true, value: [{ id: 'wanted', name: 'wanted', created: 1, hashString: 'a'.repeat(40), status: 100, totalSize: 1, downloadPercent: 100, files: [{ id: 'f', name: 'wanted.mkv', size: 1, downloadUrl: 'https://cdn.example/wanted' }] }], pagination: { next: -1 } }));
			}
			if (parsed.pathname.endsWith('/seedbox/list') && parsed.searchParams.get('page') === '0') {
				return Promise.resolve(jsonResponse({ success: true, value: [{ id: 'wanted', name: 'wanted', created: 1, hashString: 'a'.repeat(40), status: 100, totalSize: 1, downloadPercent: 100, isZip: true }], pagination: { next: 1 } }));
			}
			if (parsed.pathname.endsWith('/seedbox/list') && parsed.searchParams.get('page') === '1') {
				return Promise.resolve(jsonResponse({ success: true, value: [], pagination: { next: -1 } }));
			}
			throw new Error(`unexpected ${url}`);
		});
		vi.stubGlobal('fetch', fetchMock);
		const rows = await listLibrary('dl', 'secret-token');
		expect(rows).toHaveLength(1);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const item = await getLibraryDetail('dl', 'secret-token', 'dl:wanted');
		expect(item.files[0]?.id).toBe('f');
	});

	it('locks a Debrid-Link endpoint for an hour after floodDetected', async () => {
		_testing.resetDebridLinkFloodLockouts();
		const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ success: false, error: 'floodDetected' })));
		vi.stubGlobal('fetch', fetchMock);
		await expect(validateCredential('dl', 'secret-token')).rejects.toMatchObject({ code: 'floodDetected' });
		await expect(validateCredential('dl', 'secret-token')).rejects.toMatchObject({ code: 'floodDetected' });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('keeps Premiumize identities and converts transfer entry timestamps from seconds', () => {
		const [transfer, folder, file] = _testing.buildPremiumizeItems(
			[{ id: 't1', name: 'Transfer', status: 'finished', progress: 1, folder_id: 'folder', file_id: null }],
			[{ id: 'folder', name: 'Folder', type: 'folder', created_at: 1_700_000_000 }, { id: 'folder2', name: 'Other', type: 'folder', created_at: 1_700_000_002 }],
			[{ id: 'i1', name: 'Movie.mkv', type: 'file', path: 'Folder/Movie.mkv', size: 10, created_at: 1_700_000_001 }],
		);
		expect(transfer?.id).toBe('pm:t:t1');
		expect(transfer?.added).toBe(new Date(1_700_000_001_000).toISOString());
		expect(folder?.id).toBe('pm:f:folder2');
		expect(file).toBeUndefined();
		const [unknown] = _testing.buildPremiumizeItems([{ id: 't2', name: 'Unknown', status: 'queued' }], [], []);
		expect(unknown?.added).toBe(new Date(0).toISOString());
	});

	it('keeps a fractional Premiumize transfer progress at its percentage value', () => {
		const [item] = _testing.buildPremiumizeItems(
			[{ id: 't-fraction', name: 'Fractional', status: 'running', progress: 0.005 }],
			[],
			[],
		);
		expect(item?.progress).toBe(0.5);
	});
});

describe('provider request envelopes', () => {
	it('reads a valid library envelope for all six providers', async () => {
		const magnet = { id: 'ad-1', filename: 'ad.mkv', hash: 'a'.repeat(40), size: 1, statusCode: 4, uploadDate: 1 };
		const fetchMock = vi.fn((url: string) => {
			if (url.includes('real-debrid.com/rest/1.0/torrents')) return Promise.resolve(jsonResponse([{ id: 'rd-1', filename: 'rd.mkv', hash: 'a'.repeat(40), bytes: 1, status: 'downloaded', progress: 100, added: '2026-01-01' }], 200, { 'x-total-count': '1' }));
			if (url.endsWith('/magnet/status')) return Promise.resolve(jsonResponse({ status: 'success', data: { magnets: [magnet] } }));
			if (url.includes('/torrents/mylist')) return Promise.resolve(jsonResponse({ success: true, data: [{ id: 1, name: 'tb', download_finished: true, download_present: true, size: 1, files: [] }] }));
			if (url.includes('/webdl/mylist')) return Promise.resolve(jsonResponse({ success: true, data: [{ id: 2, name: 'web', download_finished: true, download_present: true, size: 1, files: [] }] }));
			if (url.includes('/usenet/mylist')) return Promise.resolve(jsonResponse({ success: true, data: [{ id: 3, name: 'usenet', download_finished: true, download_present: true, size: 1, files: [] }] }));
			if (url.endsWith('/transfer/list')) return Promise.resolve(jsonResponse({ status: 'success', transfers: [] }));
			if (url.endsWith('/folder/list')) return Promise.resolve(jsonResponse({ status: 'success', content: [{ id: 'pm-folder', name: 'Cloud', type: 'folder', created_at: 1_700_000_000 }] }));
			if (url.endsWith('/item/listall')) return Promise.resolve(jsonResponse({ status: 'success', files: [] }));
			if (url.endsWith('/cloud/history')) return Promise.resolve(jsonResponse([{ requestId: 'oc-1', fileName: 'oc.mkv', status: 'downloaded', createdOn: '2026-01-01' }]));
			if (url.includes('/seedbox/list')) return Promise.resolve(jsonResponse({ success: true, value: [{ id: 'dl-1', name: 'dl', created: 1, hashString: 'a'.repeat(40), status: 100, totalSize: 1, downloadPercent: 100 }], pagination: { next: -1 } }));
			throw new Error(`unexpected ${url}`);
		});
		vi.stubGlobal('fetch', fetchMock);
		for (const provider of ['rd', 'ad', 'tb', 'pm', 'oc', 'dl'] as const) {
			const rows = await listLibrary(provider, 'secret-token');
			expect(rows.length, provider).toBeGreaterThan(0);
		}
	});
});

describe('sign-in account checks', () => {
	afterEach(() => _testing.resetDebridLinkFloodLockouts());

	it('refuses a free TorBox plan, which has no API access', async () => {
		vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse(tbFreePlan))));
		await expect(validateCredential('tb', 'key')).rejects.toMatchObject({ code: 'not_premium' });
	});

	it('refuses lapsed Premiumize, Offcloud and Debrid-Link accounts', async () => {
		vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ status: 'success', customer_id: '1', premium_until: 1 }))));
		await expect(validateCredential('pm', 'key')).rejects.toMatchObject({ code: 'not_premium' });
		vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ email: 'a@example.invalid', is_premium: false }))));
		await expect(validateCredential('oc', 'key')).rejects.toMatchObject({ code: 'not_premium' });
		_testing.resetDebridLinkFloodLockouts();
		vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ success: true, value: { username: 'u', accountType: 0 } }))));
		await expect(validateCredential('dl', 'key')).rejects.toMatchObject({ code: 'not_premium' });
	});

	it('accepts a premium Premiumize account and labels it by customer id', async () => {
		vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ status: 'success', customer_id: '704233992', premium_until: 1821398400 }))));
		await expect(validateCredential('pm', 'key')).resolves.toEqual({ label: '704233992' });
	});
});

describe('adding a magnet', () => {
	it('sends Real-Debrid an xt it accepts; it refuses the percent-encoded form', async () => {
		// Real-Debrid answered the encoded xt with this 404 on 2026-11-09 and took the literal one.
		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
			const magnet = new URLSearchParams(String(init?.body)).get('magnet') ?? '';
			return magnet.includes('urn%3Abtih%3A') ? jsonResponse(rdEncodedXt.body, rdEncodedXt.status) : jsonResponse({ id: 'NEWID' }, 201);
		});
		vi.stubGlobal('fetch', fetchMock);
		const typed = 'magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=Big.Buck.Bunny';
		await expect(addMagnet('rd', 'token', parseBtihMagnet(typed).magnet)).resolves.toBeUndefined();
		expect(new URLSearchParams(String(fetchMock.mock.calls[0][1]?.body)).get('magnet')).toBe(typed);
	});
});

describe('adds, reinserts and the cached-only paths', () => {
	const HASH = rdMovie.hash;
	type Call = { url: string; method: string; body: string };
	const record = (respond: (url: string, method: string) => unknown) => {
		const calls: Call[] = [];
		vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit = {}) => {
			const method = init.method ?? 'GET';
			calls.push({ url, method, body: typeof init.body === 'string' ? init.body : '' });
			return Promise.resolve(jsonResponse(respond(url, method)));
		}));
		return calls;
	};

	it('selects every video right after a Real-Debrid add, as DMM web does', async () => {
		const calls = record((url) => url.endsWith('/addMagnet') ? { id: 'NEW' } : url.includes('/torrents/info/') ? {
			status: 'waiting_files_selection',
			files: [{ id: 1, path: '/a/movie.mkv', bytes: 1, selected: 0 }, { id: 2, path: '/a/readme.nfo', bytes: 1, selected: 0 }, { id: 3, path: '/a/extra.mp4', bytes: 1, selected: 0 }],
		} : {});
		await addMagnet('rd', 'token', `magnet:?xt=urn:btih:${HASH}`);
		const select = calls.find((call) => call.url.includes('/selectFiles/NEW'));
		expect(new URLSearchParams(select?.body).get('files')).toBe('1,3');
	});

	it('sends Debrid-Link a bare hash, so it adds only what is cached', async () => {
		const calls = record(() => ({ success: true, value: { id: 'x' } }));
		await addMagnet('dl', 'token', HASH.toUpperCase());
		expect(new URLSearchParams(calls[0].body).get('url')).toBe(HASH);
		await addMagnet('rd', 'token', 'magnet:?xt=urn:btih:' + HASH).catch(() => undefined);
	});

	it('asks TorBox for cached-only adds and removes an uncached AllDebrid upload again', async () => {
		const tb = record(() => ({ success: true, data: { torrent_id: 1 } }));
		await addMagnet('tb', 'token', HASH, undefined, { cachedOnly: true });
		expect(new URLSearchParams(tb[0].body).get('add_only_if_cached')).toBe('true');

		const ad = record((url) => url.endsWith('/magnet/upload') ? { status: 'success', data: { magnets: [{ id: 77, hash: HASH, ready: false }] } } : { status: 'success', data: {} });
		await expect(addMagnet('ad', 'token', HASH, undefined, { cachedOnly: true })).rejects.toMatchObject({ code: 'not_cached' });
		expect(ad[1].url).toMatch(/\/magnet\/delete$/);
		expect(new URLSearchParams(ad[1].body).get('id')).toBe('77');
	});

	it('reinserts on Real-Debrid with the old file selection, then deletes the old torrent', async () => {
		const calls = record((url, method) => {
			if (url.endsWith('/addMagnet')) return { id: 'NEW' };
			if (url.includes('/torrents/info/')) return rdMovie;
			if (method === 'DELETE') return null;
			return {};
		});
		await reinsertItem('token', { ..._testing.normalizeRd(rdMovie), id: `rd:${rdMovie.id}` });
		expect(new URLSearchParams(calls.find((call) => call.url.includes('/selectFiles/NEW'))?.body).get('files')).toBe('1');
		expect(calls.at(-1)).toMatchObject({ method: 'DELETE' });
		expect(calls.at(-1)?.url).toContain(`/torrents/delete/${rdMovie.id}`);
	});

	it('keeps a cached Real-Debrid torrent when a narrower selection would download again', async () => {
		const old = { ...rdTv, progress: 100 };
		const selected = _testing.rdFiles(old).filter((file) => file.selected).map((file) => file.id);
		const calls = record((url, method) => {
			if (url.endsWith('/addMagnet')) return { id: 'NEW' };
			if (url.includes('/torrents/info/NEW')) return { ...old, id: 'NEW', progress: 0, status: 'downloading' };
			if (url.includes('/torrents/info/')) return old;
			return method === 'DELETE' ? null : {};
		});
		expect(selected.length).toBeGreaterThan(1);
		await expect(reinsertItem('token', _testing.normalizeRd(old), selected.slice(0, 1))).rejects.toMatchObject({ code: 'not_cached' });
		const deletes = calls.filter((call) => call.method === 'DELETE').map((call) => call.url);
		expect(deletes).toEqual([expect.stringContaining('/torrents/delete/NEW')]);
	});

	it('reannounces an active TorBox torrent and restarts a failed AllDebrid magnet', async () => {
		const tb = record(() => ({ success: true, data: null }));
		await reinsertItem('token', _testing.normalizeTorBox({ id: 5, name: 'x', active: true, download_state: 'stalled (no seeds)' }, 'torrent'));
		expect(JSON.parse(String((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body))).toEqual({ torrent_id: 5, operation: 'reannounce' });
		expect(tb[0].url).toMatch(/controltorrent$/);
		const ad = record(() => ({ status: 'success', data: { message: 'restarted' } }));
		await reinsertItem('token', _testing.normalizeAd({ ...adStatusFixture, statusCode: 7 }));
		expect(ad[0].url).toMatch(/\/magnet\/restart$/);
		expect(new URLSearchParams(ad[0].body).get('id')).toBe(String(adStatusFixture.id));
		await expect(reinsertItem('token', { ..._testing.normalizeAd(adStatusFixture), provider: 'pm' })).rejects.toMatchObject({ code: 'unsupported' });
	});

	it('marks which rows can be reinserted and which the provider no longer serves', () => {
		expect(_testing.normalizeRd(rdMovie)).toMatchObject({ reinsertable: true, uncached: false });
		expect(_testing.normalizeRd({ ...rdMovie, links: [] })).toMatchObject({ uncached: true });
		expect(_testing.normalizeAd(adStatusFixture)).toMatchObject({ reinsertable: false, uncached: false });
		expect(_testing.normalizeAd({ ...adStatusFixture, statusCode: 11 })).toMatchObject({ reinsertable: true, uncached: true });
		expect(_testing.normalizeTorBox({ id: 1, active: false, download_finished: true, download_present: true }, 'torrent').reinsertable).toBe(false);
		expect(_testing.normalizeTorBox({ id: 1, active: true }, 'web').reinsertable).toBe(false);
	});
});

describe('Real-Debrid list page size', () => {
	it('pages at 100, the largest limit at which RD still returns every link, so cached rows are not called uncached', async () => {
		vi.stubGlobal('fetch', vi.fn((url: string) => {
			const limit = Number(new URL(url).searchParams.get('limit'));
			return Promise.resolve(jsonResponse(limit <= 100 ? rdLinksByLimit.limit100 : rdLinksByLimit.limit1000, 200, { 'x-total-count': '5' }));
		}));
		const rows = await listLibrary('rd', 'token');
		expect(rows).toHaveLength(5);
		expect(rows.filter((row) => row.uncached).map((row) => row.title)).toEqual([]);
	});
});

describe('torrent file uploads', () => {
	it('sends the file bytes as a Blob part, since expo/fetch refuses React Native {uri} parts', async () => {
		// 2026-11-09 on the Pixel 6: every multipart upload failed with "could not be reached" while
		// Real-Debrid's raw PUT of the same file worked. expo/fetch's convertFormData takes Blobs only.
		const bytes = new Uint8Array([100, 56, 58, 97, 110, 110, 111, 117, 110, 99, 101]);
		const bodies: unknown[] = [];
		vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit = {}) => {
			if (url.startsWith('file://')) return Promise.resolve(new Response(bytes));
			bodies.push(init.body);
			const body = url.includes('alldebrid') ? { status: 'success', data: { files: [{ name: 'sintel.torrent', id: 1 }] } }
				: url.includes('torbox') ? { success: true, data: { torrent_id: 1 } }
				: url.includes('premiumize') ? { status: 'success', id: 'x' }
				: url.includes('offcloud') ? { requestId: 'r1' }
				: { success: true, value: { id: 'x' } };
			return Promise.resolve(jsonResponse(body));
		}));
		const fields = { ad: 'files[]', tb: 'file', pm: 'src', oc: 'file', dl: 'file' } as const;
		for (const [provider, field] of Object.entries(fields)) {
			await addTorrentFile(provider as keyof typeof fields, 'token', { uri: 'file:///cache/sintel.torrent', name: 'sintel.torrent' });
			const part = (bodies.at(-1) as FormData).get(field);
			expect(part, provider).toBeInstanceOf(Blob);
			expect(new Uint8Array(await (part as Blob).arrayBuffer())).toEqual(bytes);
		}
	});
});
