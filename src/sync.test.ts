import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => new Map<string, string>());
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-secure-store', () => ({
	getItemAsync: vi.fn(async (key: string) => store.get(key) ?? null),
	setItemAsync: vi.fn(async (key: string, value: string) => void store.set(key, value)),
	deleteItemAsync: vi.fn(async (key: string) => void store.delete(key)),
}));

import type { ProviderId } from './model';
import { LibrarySession, type SessionApi } from './session';
import { _resetSettingsCache, loadSettings } from './settings';
import type { CredentialStorage } from './storage';
import { credentialsFromState, identitiesFor, mergeState, readValue, settingsFromState, stateFromApp, type BrowserStateApi } from './sync';

// localStorage as DMM web leaves it: useLocalStorage JSON-quotes values and wraps expiring
// ones in { value, expiry }; Settings writes `settings:player` raw (src/hooks/localStorage.ts,
// src/components/SettingsSection.tsx:130).
const WEB_STATE = {
	'rd:clientId': '"RDCLIENT"',
	'rd:clientSecret': '"RDSECRET"',
	'rd:refreshToken': '"RDDEVICECODE"',
	'rd:accessToken': JSON.stringify({ value: 'RDOLD', expiry: 1 }),
	'ad:apiKey': '"ADKEY"',
	'dl:accessToken': JSON.stringify({ value: 'DLTOKEN', expiry: 4102444800000 }),
	'dl:refreshToken': '"DLREFRESH"',
	'dl:tokenExpiry': '4102444800000',
	'trakt:accessToken': '"TRAKT"',
	'settings:player': 'android/org.videolan.vlc',
	'settings:movieMaxSize': '"30"',
	'settings:addMagnetProvider': 'ad',
};

describe('DMM web state <-> app', () => {
	it('reads raw, JSON-quoted and enveloped values, and drops an expired envelope', () => {
		expect(readValue('raw')).toBe('raw');
		expect(readValue('"quoted"')).toBe('quoted');
		expect(readValue(WEB_STATE['dl:accessToken'])).toBe('DLTOKEN');
		expect(readValue(WEB_STATE['rd:accessToken'])).toBeNull();
	});

	it('turns DMM web logins into app logins, minting a Real-Debrid token from the device triple', () => {
		const found = credentialsFromState(WEB_STATE);
		expect(found.rd).toMatchObject({ token: '', clientId: 'RDCLIENT', clientSecret: 'RDSECRET', refresh: 'RDDEVICECODE' });
		expect(found.ad).toEqual({ token: 'ADKEY' });
		expect(found.dl).toMatchObject({ token: 'DLTOKEN', refresh: 'DLREFRESH', expiresAt: 4102444800000 });
		expect(settingsFromState(WEB_STATE)).toEqual({ player: 'android/org.videolan.vlc', addProvider: 'ad' });
	});

	it('writes app logins the way DMM web reads them, round-tripping', () => {
		const app = {
			rd: { token: 'RDTOKEN', clientId: 'C', clientSecret: 'S', refresh: 'DEV', expiresAt: 5 },
			tb: { token: 'TBKEY' },
			pm: { token: 'PMOAUTH', expiresAt: 4102444800000 },
			dl: { token: 'DLKEY' },
		};
		const state = stateFromApp(app, { player: 'android/org.videolan.vlc' });
		expect(state).toEqual({
			'rd:clientId': '"C"',
			'rd:clientSecret': '"S"',
			'rd:refreshToken': '"DEV"',
			'tb:apiKey': '"TBKEY"',
			'pm:accessToken': '"PMOAUTH"',
			'dl:apiKey': '"DLKEY"',
			'settings:player': 'android/org.videolan.vlc',
		});
		expect(identitiesFor(app)).toEqual([
			{ service: 'rd', clientId: 'C', clientSecret: 'S', refreshToken: 'DEV' },
			{ service: 'tb', apiKey: 'TBKEY' },
			{ service: 'pm', apiKey: 'PMOAUTH' },
			{ service: 'dl', apiKey: 'DLKEY' },
		]);
		expect(credentialsFromState(state).tb).toEqual({ token: 'TBKEY' });
	});

	it('keeps what DMM web saved that the app does not use, drops removed logins, and lets the app login win', () => {
		const merged = mergeState(
			{ ...WEB_STATE, 'pm:apiKey': '"OLDPM"' },
			{ 'pm:accessToken': '"NEWPM"', 'settings:player': 'android/com.brouken.player' },
			['ad']
		);
		expect(merged['trakt:accessToken']).toBe('"TRAKT"');
		expect(merged['settings:movieMaxSize']).toBe('"30"');
		expect(merged['ad:apiKey']).toBeUndefined();
		expect(merged['pm:apiKey']).toBeUndefined();
		expect(merged['pm:accessToken']).toBe('"NEWPM"');
		expect(merged['settings:player']).toBe('android/com.brouken.player');
	});
});

describe('remember across devices in the session', () => {
	const storage = (): CredentialStorage => {
		const values = new Map<ProviderId, string>();
		return { get: async (p) => values.get(p) ?? null, set: async (p, t) => void values.set(p, t), remove: async (p) => void values.delete(p) };
	};
	const api = (): SessionApi => ({
		validateCredential: vi.fn(async (provider: ProviderId) => ({ label: `${provider}-user` })),
		listLibrary: vi.fn(async () => []),
		getLibraryDetail: vi.fn(),
		resolveFile: vi.fn(),
		addMagnet: vi.fn(),
		deleteLibraryItem: vi.fn(),
		selectRealDebridFiles: vi.fn(),
		renewCredential: vi.fn(async (_provider, credential) => ({ ...credential, token: 'MINTED', expiresAt: Date.now() + 3600_000 })),
		addTorrentFile: vi.fn(),
		addWebDownload: vi.fn(),
		reinsertItem: vi.fn(),
		findRealDebridUncached: vi.fn(),
	});

	beforeEach(() => {
		store.clear();
		_resetSettingsCache();
	});

	it('signs in to the other saved providers and adopts saved settings after one sign-in, then saves the merged state', async () => {
		vi.useFakeTimers();
		try {
			const saved: { identities: unknown[]; state: Record<string, string> }[] = [];
			const sync: BrowserStateApi = {
				restore: vi.fn(async () => ({ ...WEB_STATE })),
				save: vi.fn(async (identities, state) => void saved.push({ identities, state })),
			};
			const providerApi = api();
			const session = new LibrarySession(storage(), providerApi, sync);
			await session.connect('tb', 'TBKEY');
			await vi.advanceTimersByTimeAsync(3000);

			expect(sync.restore).toHaveBeenCalledWith({ service: 'tb', apiKey: 'TBKEY' });
			const connected = session.snapshot().connected;
			expect([connected.tb, connected.ad, connected.rd, connected.dl]).toEqual([true, true, true, true]);
			expect(providerApi.renewCredential).toHaveBeenCalledWith('rd', expect.objectContaining({ refresh: 'RDDEVICECODE' }));
			expect(await loadSettings()).toEqual({ player: 'android/org.videolan.vlc', addProvider: 'ad' });

			const last = saved.at(-1)!;
			expect(last.identities).toContainEqual({ service: 'tb', apiKey: 'TBKEY' });
			expect(last.state['tb:apiKey']).toBe('"TBKEY"');
			expect(last.state['trakt:accessToken']).toBe('"TRAKT"');

			await session.disconnect('ad');
			await vi.advanceTimersByTimeAsync(3000);
			expect(saved.at(-1)!.state['ad:apiKey']).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it('brings back a provider removed earlier on this phone once another device saved it again', async () => {
		// 2026-11-09 on the Pixel 6: AllDebrid removed in the app, saved again by DMM web, then a fresh
		// Real-Debrid sign-in restored nothing and the next save deleted AllDebrid from DMM.
		vi.useFakeTimers();
		try {
			let remote: Record<string, string> = {};
			const sync: BrowserStateApi = {
				restore: vi.fn(async () => ({ ...remote })),
				save: vi.fn(async (_identities, state) => void (remote = { ...state })),
			};
			const session = new LibrarySession(storage(), api(), sync);
			await session.connect('rd', 'RDKEY');
			await session.connect('ad', 'ADKEY');
			await vi.advanceTimersByTimeAsync(3000);
			await session.disconnect('ad');
			await session.disconnect('rd');
			await vi.advanceTimersByTimeAsync(3000);
			remote = { 'rd:accessToken': '"RDKEY"', 'ad:apiKey': '"ADKEY"', 'trakt:userSlug': '"web"' };

			await session.connect('rd', 'RDKEY');
			await vi.advanceTimersByTimeAsync(3000);

			expect(session.snapshot().connected.ad).toBe(true);
			expect(remote['ad:apiKey']).toBe('"ADKEY"');
			expect(remote['trakt:userSlug']).toBe('"web"');
		} finally {
			vi.useRealTimers();
		}
	});

	it('reads DMM fresh before each save, so a login another device added in between survives', async () => {
		vi.useFakeTimers();
		try {
			let remote: Record<string, string> = {};
			const sync: BrowserStateApi = {
				restore: vi.fn(async () => ({ ...remote })),
				save: vi.fn(async (_identities, state) => void (remote = { ...state })),
			};
			const session = new LibrarySession(storage(), api(), sync);
			await session.connect('rd', 'RDKEY');
			await vi.advanceTimersByTimeAsync(3000);
			remote = { ...remote, 'oc:apiKey': '"FROM-WEB"' };
			session.schedulePush(0);
			await vi.advanceTimersByTimeAsync(10);
			expect(remote['oc:apiKey']).toBe('"FROM-WEB"');
		} finally {
			vi.useRealTimers();
		}
	});

		it('keeps a setting this device already chose over the saved one', async () => {
		store.set('dmm.library.player', 'android/com.brouken.player');
		const sync: BrowserStateApi = { restore: vi.fn(async () => ({ ...WEB_STATE })), save: vi.fn(async () => undefined) };
		const session = new LibrarySession(storage(), api(), sync);
		await session.connect('tb', 'TBKEY');
		await vi.waitFor(() => expect(sync.restore).toHaveBeenCalled());
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect((await loadSettings()).player).toBe('android/com.brouken.player');
	});
});
