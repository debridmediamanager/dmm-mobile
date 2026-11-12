import { beforeEach, describe, expect, it, vi } from 'vitest';

const secure = vi.hoisted(() => new Map<string, string>());
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-secure-store', () => ({
	getItemAsync: vi.fn(async (key: string) => secure.get(key) ?? null),
	setItemAsync: vi.fn(async (key: string, value: string) => void secure.set(key, value)),
	deleteItemAsync: vi.fn(async (key: string) => void secure.delete(key)),
}));

import type { ProviderId } from './model';
import { LibrarySession, type SessionApi } from './session';
import { _resetSettingsCache } from './settings';
import type { CredentialStorage } from './storage';
import type { BrowserStateApi } from './sync';
import { loginFromState, pollTraktLink, renewTraktLogin, startTraktLink, stateFromLogin, TraktAccount, type SecretStore, type TraktLogin } from './trakt';
import start from './test/fixtures/dmm-trakt-start-2026-11-12.json';
import pending from './test/fixtures/dmm-trakt-poll-pending-2026-11-12.json';
import linked from './test/fixtures/dmm-trakt-poll-linked-2026-11-12.json';
import renewed from './test/fixtures/dmm-trakt-refresh-2026-11-12.json';
import relink from './test/fixtures/dmm-trakt-refresh-relink-2026-11-12.json';
import webState from './test/fixtures/dmm-web-trakt-state-2026-11-12.json';

const NOW = Date.parse('2026-11-12T12:00:00Z');
const DAY = 24 * 3600_000;
const reply = (fixture: { status: number; body: unknown }) => async () => ({ status: fixture.status, data: fixture.body });
const memory = (): SecretStore & { text: () => string | null } => {
	let text: string | null = null;
	return { read: async () => text, write: async (next) => void (text = next), text: () => text };
};
const hooks = (state: Record<string, string> | null = null) => ({ pull: vi.fn(async () => state), changed: vi.fn() });
const login = (expiresAt: number, refreshToken = 'RT-OLD', accessToken = 'AT-OLD'): TraktLogin => ({ accessToken, refreshToken, expiresAt, slug: 'dmm-test' });

describe("DMM web's Trakt login", () => {
	it('reads the login DMM web saved (its callback writes the access token with an expiry) and writes it back the same way', () => {
		const found = loginFromState(webState);
		expect(found).toMatchObject({ accessToken: expect.any(String), refreshToken: expect.any(String), slug: expect.any(String) });
		expect(found!.expiresAt).toBe(JSON.parse(webState['trakt:accessToken']).expiry);
		expect(loginFromState(stateFromLogin(found!))).toEqual(found);
		expect(stateFromLogin(found!)['trakt:accessToken']).toBe(webState['trakt:accessToken']);
	});

	it('keeps the refresh token of an expired login, and needs one to count as a login at all', () => {
		expect(loginFromState({ 'trakt:refreshToken': '"RT"' })).toEqual({ accessToken: '', refreshToken: 'RT', expiresAt: 1 });
		expect(loginFromState({ 'trakt:accessToken': JSON.stringify({ value: 'AT', expiry: 5 }), 'trakt:refreshToken': '"RT"' })).toMatchObject({ accessToken: 'AT', expiresAt: 5 });
		// The shape DMM web had before its callback stored an expiry: a bare token, renewed at once.
		expect(loginFromState({ 'trakt:accessToken': '"AT"', 'trakt:refreshToken': '"RT"' })).toMatchObject({ accessToken: 'AT', expiresAt: 1 });
		expect(loginFromState({ 'trakt:accessToken': '"AT"' })).toBeNull();
		expect(stateFromLogin({ accessToken: '', refreshToken: 'RT', expiresAt: 1 })).toEqual({ 'trakt:refreshToken': '"RT"' });
	});
});

describe("DMM's Trakt device link and renewal (/api/kodi/tracker/*, live answers 2026-11-12)", () => {
	it('starts a link with the code and the approve page holding it', async () => {
		expect(await startTraktLink(reply(start))).toEqual({ userCode: start.body.userCode, deviceCode: 'DEVICECODE', verifyUrl: start.body.verifyUrl, page: 'auth.trakt.tv/activate', interval: 6, expiresIn: 600 });
	});

	it('polls: pending, then the tokens and who approved', async () => {
		expect(await pollTraktLink('DEVICECODE', reply(pending))).toBe('pending');
		expect(await pollTraktLink('DEVICECODE', async () => ({ status: 410, data: { status: 'expired' } }))).toBe('expired');
		const done = await pollTraktLink('DEVICECODE', reply(linked));
		expect(done).toEqual({ accessToken: linked.body.accessToken, refreshToken: linked.body.refreshToken, expiresAt: Date.parse(linked.body.expiresAt), slug: linked.body.user.slug });
	});

	it('renews, keeping the user, and tells a dead refresh token apart', async () => {
		const fresh = await renewTraktLogin(login(NOW), reply(renewed));
		expect(fresh).toEqual({ accessToken: renewed.body.accessToken, refreshToken: renewed.body.refreshToken, expiresAt: Date.parse(renewed.body.expiresAt), slug: 'dmm-test' });
		expect(await renewTraktLogin(login(NOW), reply(relink))).toBe('relink');
		await expect(renewTraktLogin(login(NOW), async () => ({ status: 503, data: { error: 'Could not reach Trakt right now. Try again in a minute.' } }))).rejects.toThrow('Could not reach Trakt');
	});
});

describe('TraktAccount', () => {
	it('adopts a login saved elsewhere only when it is newer, and never the one disconnected here', async () => {
		const account = new TraktAccount(hooks(), vi.fn(), memory(), () => NOW);
		expect(await account.adopt(stateFromLogin(login(NOW + 7 * DAY)))).toBe(true);
		// The same login, or an older one (a browser still holding what this device renewed away), changes nothing.
		expect(await account.adopt(stateFromLogin(login(NOW + 7 * DAY)))).toBe(false);
		expect(await account.adopt(stateFromLogin(login(NOW + 2 * DAY, 'RT-STALE')))).toBe(false);
		expect(await account.adopt(stateFromLogin(login(NOW + 8 * DAY, 'RT-NEW')))).toBe(true);
		expect(account.login?.refreshToken).toBe('RT-NEW');

		await account.disconnect();
		expect(account.login).toBeNull();
		expect(account.removed).toBe(true);
		expect(await account.adopt(stateFromLogin(login(NOW + 8 * DAY, 'RT-NEW')))).toBe(false);
		// Signing in to Trakt again on DMM web makes a newer login: that one is used.
		expect(await account.adopt(stateFromLogin(login(NOW + 9 * DAY, 'RT-AGAIN')))).toBe(true);
	});

	it('uses the token until its last hour, then renews through DMM, keeps the new one and saves it across devices at once', async () => {
		let now = NOW;
		const store = memory();
		const calls = hooks();
		const post = vi.fn(reply(renewed));
		const account = new TraktAccount(calls, post, store, () => now);
		await account.connect(login(NOW + 7 * DAY));
		calls.changed.mockClear();
		expect(await account.token()).toBe('AT-OLD');
		expect(post).not.toHaveBeenCalled();

		now = NOW + 7 * DAY - 30 * 60_000;
		expect(await account.token()).toBe(renewed.body.accessToken);
		expect(post).toHaveBeenCalledWith('/api/kodi/tracker/refresh', { service: 'trakt', refreshToken: 'RT-OLD' });
		expect(JSON.parse(store.text()!).login.refreshToken).toBe(renewed.body.refreshToken);
		expect(calls.changed).toHaveBeenCalledTimes(1);
		// What the next save carries, in DMM web's format.
		expect(account.state()).toEqual(stateFromLogin({ accessToken: renewed.body.accessToken, refreshToken: renewed.body.refreshToken, expiresAt: Date.parse(renewed.body.expiresAt), slug: 'dmm-test' }));
	});

	it('renews once for many callers at a time', async () => {
		const post = vi.fn(reply(renewed));
		const account = new TraktAccount(hooks(), post, memory(), () => NOW);
		await account.connect(login(NOW + 60_000));
		const tokens = await Promise.all([account.token(), account.token(), account.token(true)]);
		expect(new Set(tokens)).toEqual(new Set([renewed.body.accessToken]));
		expect(post).toHaveBeenCalledTimes(1);
	});

	it('takes the login another device renewed instead of renewing with a refresh token that died with it', async () => {
		const elsewhere = login(NOW + 7 * DAY, 'RT-ELSEWHERE', 'AT-ELSEWHERE');
		const post = vi.fn(reply(renewed));
		const account = new TraktAccount(hooks(stateFromLogin(elsewhere)), post, memory(), () => NOW);
		await account.connect(login(NOW + 60_000));
		expect(await account.token()).toBe('AT-ELSEWHERE');
		expect(post).not.toHaveBeenCalled();
	});

	it('looks again after Trakt refuses the refresh token, and asks to connect again when nothing newer is saved', async () => {
		const account = new TraktAccount(hooks(), vi.fn(reply(relink)), memory(), () => NOW);
		await account.connect(login(NOW - DAY));
		expect(await account.token()).toBeNull();
		expect(account.refused).toBe(true);
		expect(account.login?.refreshToken).toBe('RT-OLD');

		// A token Trakt refused (401) before its expiry: renewed without waiting for it.
		const again = new TraktAccount(hooks(), vi.fn(reply(renewed)), memory(), () => NOW);
		await again.connect(login(NOW + 7 * DAY));
		expect(await again.token(true)).toBe(renewed.body.accessToken);
	});
});

describe('the Trakt login in the saved state (remember across devices)', () => {
	const storage = (): CredentialStorage => {
		const values = new Map<ProviderId, string>();
		return { get: async (p) => values.get(p) ?? null, set: async (p, t) => void values.set(p, t), remove: async (p) => void values.delete(p) };
	};
	const api = (): SessionApi => ({
		validateCredential: vi.fn(async () => ({ label: 'user' })),
		listLibrary: vi.fn(async () => []),
		getLibraryDetail: vi.fn(),
		resolveFile: vi.fn(),
		addMagnet: vi.fn(),
		deleteLibraryItem: vi.fn(),
		selectRealDebridFiles: vi.fn(),
		renewCredential: vi.fn(async (_provider, credential) => credential),
		addTorrentFile: vi.fn(),
		addWebDownload: vi.fn(),
		reinsertItem: vi.fn(),
		findRealDebridUncached: vi.fn(),
	});

	beforeEach(() => {
		secure.clear();
		_resetSettingsCache();
	});

	it("picks up DMM web's login at sign-in, saves a renewal back for DMM web, and takes it out of DMM's store on disconnect", async () => {
		vi.useFakeTimers({ now: NOW });
		try {
			let remote: Record<string, string> = { 'pm:apiKey': '"PMKEY"', ...webState };
			const sync: BrowserStateApi = {
				restore: vi.fn(async () => ({ ...remote })),
				save: vi.fn(async (_identities, state) => void (remote = { ...state })),
			};
			const session = new LibrarySession(storage(), api(), sync);
			await session.connect('pm', 'PMKEY');
			await vi.advanceTimersByTimeAsync(3000);
			expect(session.trakt!.login).toEqual(loginFromState(webState));

			// A newer login (this device renewed) replaces DMM web's in the saved state.
			const newer = login(NOW + 8 * DAY, 'RT-RENEWED', 'AT-RENEWED');
			await session.trakt!.connect(newer);
			await vi.advanceTimersByTimeAsync(10);
			expect(loginFromState(remote)).toEqual(newer);
			expect(remote['pm:apiKey']).toBe('"PMKEY"');

			// DMM web saving its stale copy again does not undo it: the app's newer login wins the next save.
			remote = { ...remote, ...webState };
			session.schedulePush(0);
			await vi.advanceTimersByTimeAsync(10);
			expect(loginFromState(remote)).toEqual(newer);

			await session.trakt!.disconnect();
			await vi.advanceTimersByTimeAsync(10);
			expect(remote['trakt:accessToken']).toBeUndefined();
			expect(remote['trakt:refreshToken']).toBeUndefined();
			expect(remote['pm:apiKey']).toBe('"PMKEY"');
		} finally {
			vi.useRealTimers();
		}
	});

	it('forgets Trakt when the last provider is disconnected, so the next person signing in does not inherit it', async () => {
		const sync: BrowserStateApi = { restore: vi.fn(async () => ({ ...webState })), save: vi.fn(async () => undefined) };
		const session = new LibrarySession(storage(), api(), sync);
		await session.connect('tb', 'TBKEY');
		await vi.waitFor(() => expect(session.trakt!.login).not.toBeNull());
		await session.disconnect('tb');
		await vi.waitFor(() => expect(session.trakt!.login).toBeNull());
		expect(session.trakt!.removed).toBe(false);
	});

	it('never syncs Trakt for the demo key, and has no Trakt where nothing syncs', () => {
		expect(new LibrarySession(storage(), api()).trakt).toBeNull();
	});
});
