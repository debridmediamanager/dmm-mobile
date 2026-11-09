import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-secure-store', () => ({
	getItemAsync: vi.fn(),
	setItemAsync: vi.fn(),
	deleteItemAsync: vi.fn(),
}));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

import type { ProviderId } from './model';
import type { SessionApi } from './session';
import { LibrarySession } from './session';
import type { CredentialStorage } from './storage';

const storage = (): CredentialStorage => {
	const values = new Map<ProviderId, string>();
	return {
		get: async (provider) => values.get(provider) ?? null,
		set: async (provider, token) => void values.set(provider, token),
		remove: async (provider) => void values.delete(provider),
	};
};

const deferred = <T,>() => {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
};

const row = (id: string) => ({
	id,
	provider: 'rd' as const,
	title: id,
	filename: `${id}.mkv`,
	hash: '',
	size: 1,
	progress: 100,
	status: 'finished' as const,
	serviceStatus: 'downloaded',
	added: '2026-01-01T00:00:00.000Z',
	files: [],
});

const api = (listLibrary: SessionApi['listLibrary']): SessionApi => ({
	validateCredential: vi.fn(async () => ({ label: 'account' })),
	listLibrary,
	getLibraryDetail: vi.fn(),
	resolveFile: vi.fn(),
	addMagnet: vi.fn(),
	deleteLibraryItem: vi.fn(),
	selectRealDebridFiles: vi.fn(),
	renewCredential: vi.fn(),
	addTorrentFile: vi.fn(),
	addWebDownload: vi.fn(),
	reinsertItem: vi.fn(),
});

describe('secure session lifecycle', () => {
	it('does not save a rejected credential', async () => {
		const saved = storage();
		const session = new LibrarySession(saved, {
			...api(vi.fn()),
			validateCredential: vi.fn(async () => { throw new Error('bad token'); }),
		});
		await expect(session.connect('rd', 'bad')).rejects.toThrow('bad token');
		expect(session.snapshot().connected.rd).toBe(false);
		expect(await saved.get('rd')).toBeNull();
	});

	it('drops stale provider responses after disconnect', async () => {
		let resolveList!: (rows: ReturnType<typeof row>[]) => void;
		const list = vi.fn(() => new Promise<ReturnType<typeof row>[]>((resolve) => { resolveList = resolve; }));
		const session = new LibrarySession(storage(), api(list as SessionApi['listLibrary']));
		await session.connect('rd', 'token');
		const refresh = session.refreshProvider('rd');
		await session.disconnect('rd');
		resolveList([row('stale')]);
		await refresh;
		expect(session.snapshot().connected.rd).toBe(false);
		expect(session.snapshot().items).toEqual([]);
	});

	it('keeps a prior successful library when a later refresh fails', async () => {
		const list = vi.fn()
			.mockResolvedValueOnce([row('kept')])
			.mockRejectedValueOnce(new Error('temporary outage'));
		const session = new LibrarySession(storage(), api(list as SessionApi['listLibrary']));
		await session.connect('rd', 'token');
		await session.refreshProvider('rd');
		await session.refreshProvider('rd');
		expect(session.snapshot().items.map((entry) => entry.id)).toEqual(['kept']);
		expect(session.snapshot().failures[0].message).toBe('temporary outage');
	});

	it('captures the credential-read generation before awaiting secure storage', async () => {
		const values = new Map<ProviderId, string>([['rd', 'old-token']]);
		const read = deferred<string | null>();
		const saved: CredentialStorage = {
			get: async (provider) => provider === 'rd' ? read.promise : values.get(provider) ?? null,
			set: async (provider, token) => void values.set(provider, token),
			remove: async (provider) => void values.delete(provider),
		};
		const session = new LibrarySession(saved, api(vi.fn()));
		const loading = session.loadCredentials();
		await session.disconnect('rd');
		read.resolve('old-token');
		await loading;
		expect(session.snapshot().connected.rd).toBe(false);
	});

	it('does not let a stale refresh clear a newer refresh loading state', async () => {
		const first = deferred<ReturnType<typeof row>[]>();
		const second = deferred<ReturnType<typeof row>[]>();
		const list = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
		const session = new LibrarySession(storage(), api(list as SessionApi['listLibrary']));
		await session.connect('rd', 'token');
		const oldRefresh = session.refreshProvider('rd');
		const newRefresh = session.refreshProvider('rd');
		first.resolve([row('stale')]);
		await Promise.resolve();
		expect(session.snapshot().loading.rd).toBe(true);
		second.resolve([row('fresh')]);
		await Promise.all([oldRefresh, newRefresh]);
		expect(session.snapshot().items.map((entry) => entry.id)).toEqual(['fresh']);
		expect(session.snapshot().loading.rd).toBe(false);
	});

	it('notifies loading start and each provider settle independently', async () => {
		const rd = deferred<ReturnType<typeof row>[]>();
		const ad = deferred<ReturnType<typeof row>[]>();
		const list = vi.fn((provider: ProviderId) => provider === 'rd' ? rd.promise : ad.promise);
		const session = new LibrarySession(storage(), api(list as SessionApi['listLibrary']));
		await session.connect('rd', 'rd-token');
		await session.connect('ad', 'ad-token');
		const snapshots: Array<{ rd: boolean; ad: boolean; items: string[] }> = [];
		const unsubscribe = session.subscribe(() => {
			const current = session.snapshot();
			snapshots.push({ rd: current.loading.rd, ad: current.loading.ad, items: current.items.map((entry) => entry.id) });
		});
		const refresh = session.refreshAll();
		await Promise.resolve();
		expect(snapshots.some((entry) => entry.rd && entry.ad)).toBe(true);
		rd.resolve([row('rd-row')]);
		await Promise.resolve();
		expect(snapshots.some((entry) => entry.items.includes('rd-row') && entry.ad)).toBe(true);
		ad.resolve([row('ad-row')]);
		await refresh;
		unsubscribe();
		expect(session.snapshot().items.map((entry) => entry.id)).toEqual(['rd-row', 'ad-row']);
	});

	it('rejects a file open that resolves after disconnect', async () => {
		const open = deferred<string>();
		const session = new LibrarySession(storage(), { ...api(vi.fn()), resolveFile: vi.fn(() => open.promise) });
		await session.connect('rd', 'token');
		const pending = session.openFile('rd', row('item'), 'file');
		await session.disconnect('rd');
		open.resolve('https://cdn.example/file');
		await expect(pending).rejects.toThrow('Connection changed');
	});

	it('serializes credential writes across cancelled connect operations', async () => {
		const values = new Map<ProviderId, string>();
		const oldSet = deferred<void>();
		const writes: string[] = [];
		const saved: CredentialStorage = {
			get: async (provider) => values.get(provider) ?? null,
			set: async (provider, token) => {
				writes.push(`set:${token}`);
				if (token === 'old-token') await oldSet.promise;
				values.set(provider, token);
			},
			remove: async (provider) => { writes.push('remove'); values.delete(provider); },
		};
		const validate = vi.fn(async () => ({}));
		const session = new LibrarySession(saved, { ...api(vi.fn()), validateCredential: validate });
		const oldConnect = session.connect('rd', 'old-token');
		await Promise.resolve();
		const disconnect = session.disconnect('rd');
		const newConnect = session.connect('rd', 'new-token');
		oldSet.resolve();
		await expect(oldConnect).rejects.toThrow('cancelled');
		await disconnect;
		await newConnect;
		expect(await saved.get('rd')).toBe('new-token');
		expect(writes).toEqual(['set:old-token', 'remove', 'set:new-token']);
	});

	it('surfaces secure-store removal failures after clearing the in-memory session', async () => {
		const saved: CredentialStorage = {
			get: async () => null,
			set: async () => undefined,
			remove: async () => { throw new Error('keychain unavailable'); },
		};
		const session = new LibrarySession(saved, api(vi.fn()));
		await expect(session.connect('rd', 'token')).resolves.toBeUndefined();
		await expect(session.disconnect('rd')).rejects.toThrow('keychain unavailable');
		expect(session.snapshot().connected.rd).toBe(false);
		expect(session.snapshot().failures[0]?.message).toContain('Secure credential removal failed');
	});

	it('renews an expiring device sign-in before listing and saves the new token', async () => {
		const saved = storage();
		await saved.set('rd', JSON.stringify({ token: 'old', refresh: 'device', clientId: 'C', clientSecret: 'S', expiresAt: Date.now() - 1 }));
		const list = vi.fn(async () => [row('rd:1')]);
		const renew = vi.fn(async (_provider: ProviderId, credential: { token: string }) => ({ ...credential, token: 'fresh', expiresAt: Date.now() + 86_400_000 }));
		const session = new LibrarySession(saved, { ...api(list), renewCredential: renew });
		await session.loadCredentials();
		await Promise.all([session.refreshProvider('rd'), session.refreshProvider('rd')]);
		expect(renew).toHaveBeenCalledTimes(1);
		expect(list).toHaveBeenLastCalledWith('rd', 'fresh', expect.anything());
		expect(JSON.parse((await saved.get('rd')) ?? '{}')).toMatchObject({ token: 'fresh', refresh: 'device' });
	});

	it('shows a failed renewal instead of listing with a dead token', async () => {
		const saved = storage();
		await saved.set('dl', JSON.stringify({ token: 'old', refresh: 'r', expiresAt: 1 }));
		const list = vi.fn();
		const session = new LibrarySession(saved, { ...api(list), renewCredential: vi.fn(async () => { throw new Error('Sign in again.'); }) });
		await session.loadCredentials();
		await session.refreshProvider('dl');
		expect(list).not.toHaveBeenCalled();
		expect(session.snapshot().failures[0]).toMatchObject({ provider: 'dl', message: 'Sign in again.' });
	});

	it('keeps the account label across a restart and still reads a bare key from older installs', async () => {
		const saved = storage();
		await new LibrarySession(saved, api(vi.fn())).connect('tb', '  key  ');
		const restarted = new LibrarySession(saved, api(vi.fn()));
		await restarted.loadCredentials();
		expect(restarted.snapshot().labels.tb).toBe('account');

		await saved.set('ad', 'bare-key');
		const list = vi.fn(async () => []);
		const older = new LibrarySession(saved, api(list));
		await older.loadCredentials();
		await older.refreshProvider('ad');
		expect(list).toHaveBeenCalledWith('ad', 'bare-key', expect.anything());
	});
});
