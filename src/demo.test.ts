import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('expo-secure-store', () => ({ getItemAsync: vi.fn(async () => null), setItemAsync: vi.fn(), deleteItemAsync: vi.fn() }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

import { DEMO_KEY, resetDemo, withDemo } from './demo';
import type { ProviderId } from './model';
import { LibrarySession, type SessionApi } from './session';
import type { CredentialStorage } from './storage';
import { identitiesFor, stateFromApp, type BrowserStateApi } from './sync';

const storage = (): CredentialStorage => {
	const values = new Map<ProviderId, string>();
	return {
		get: async (provider) => values.get(provider) ?? null,
		set: async (provider, token) => void values.set(provider, token),
		remove: async (provider) => void values.delete(provider),
	};
};

// Any provider call fails the test: the demo key must never leave the device.
const providers = new Proxy({}, { get: (_target, name) => vi.fn(async () => { throw new Error(`provider called: ${String(name)}`); }) }) as SessionApi;
const sync = (): BrowserStateApi => ({ restore: vi.fn(async () => null), save: vi.fn(async () => undefined) });

afterEach(resetDemo);

describe('the demo library reviewers sign in with', () => {
	it('signs in with the key on any provider, without calling one, and lists the open movies', async () => {
		const dmm = sync();
		const session = new LibrarySession(storage(), withDemo(providers), dmm);
		await session.connect('tb', ` ${DEMO_KEY.toUpperCase()} `);
		await session.refreshAll();

		const { items, labels } = session.snapshot();
		expect(labels.tb).toBe('Demo library');
		expect(items.map((item) => item.title)).toEqual(['Tears of Steel (2012) 1080p', 'Sintel (2010) 2K', 'Big Buck Bunny (2008) 720p', 'Cosmos Laundromat (2015)']);
		expect(dmm.restore).not.toHaveBeenCalled();
		expect(dmm.save).not.toHaveBeenCalled();
	});

	it('plays a real file and refuses the one still downloading', async () => {
		const session = new LibrarySession(storage(), withDemo(providers), null);
		await session.connect('tb', DEMO_KEY);
		await session.refreshAll();
		const [tears, , , cosmos] = session.snapshot().items;

		expect(await session.openFile('tb', tears, '1')).toBe('https://archive.org/download/Tears-of-Steel/tears_of_steel_1080p.mp4');
		await expect(session.openFile('tb', cosmos, '1')).rejects.toThrow('still downloading');
	});

	it('takes adds and deletes for the rest of the session', async () => {
		const session = new LibrarySession(storage(), withDemo(providers), null);
		await session.connect('rd', DEMO_KEY);
		await session.refreshAll();
		await session.add('rd', 'magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=Big+Buck+Bunny');
		await session.remove('rd', 'rd:demo2');

		const titles = session.snapshot().items.map((item) => `${item.title} ${item.serviceStatus}`);
		expect(titles).toContain('Big Buck Bunny queued (demo)');
		expect(titles.some((title) => title.startsWith('Sintel'))).toBe(false);
	});

	it('keeps the key out of DMM sync and the browser handoff', () => {
		const credentials = { tb: { token: DEMO_KEY }, pm: { token: 'pm-key' } };

		expect(identitiesFor(credentials)).toEqual([{ service: 'pm', apiKey: 'pm-key' }]);
		expect(stateFromApp(credentials, {})).toEqual({ 'pm:apiKey': '"pm-key"' });
	});

	it('passes every other key to its provider', async () => {
		const listLibrary = vi.fn(async () => []);
		await withDemo({ ...providers, listLibrary } as SessionApi).listLibrary('rd', 'real-token');
		expect(listLibrary).toHaveBeenCalledWith('rd', 'real-token', undefined);
	});
});
