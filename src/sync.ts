import type { StoredCredential } from './auth';
import type { ProviderId } from './model';
import { PROVIDERS } from './model';
import { isDemoToken } from './demo';
import { SETTINGS, type AppSettings, type SettingName } from './settings';
import { DMM_ORIGIN } from './tvLink';

/**
 * DMM web's "remember my logins and settings across devices", always on in the app.
 * The state is DMM web's: raw localStorage strings under its keys
 * (src/utils/browserStateKeys.ts), behind each provider login that proves it.
 */
export type BrowserState = Record<string, string>;

export type SyncIdentity =
	| { service: 'rd'; clientId: string; clientSecret: string; refreshToken: string }
	| { service: ProviderId; apiKey: string };


type Credentials = Partial<Record<ProviderId, StoredCredential>>;

/** The keys each provider's login, and Trakt's, live under on DMM web. */
const LOGIN_KEYS: Record<ProviderId | 'trakt', string[]> = {
	rd: ['rd:clientId', 'rd:clientSecret', 'rd:refreshToken', 'rd:accessToken'],
	ad: ['ad:apiKey'],
	tb: ['tb:apiKey'],
	pm: ['pm:accessToken', 'pm:apiKey'],
	oc: ['oc:apiKey'],
	dl: ['dl:accessToken', 'dl:refreshToken', 'dl:tokenExpiry', 'dl:apiKey'],
	trakt: ['trakt:accessToken', 'trakt:refreshToken', 'trakt:userSlug'],
};

/** A device sign-in carries an expiry (RD, DL) or OAuth client data; a pasted key has neither. */
const isDeviceLogin = (credential: StoredCredential): boolean =>
	Boolean(credential.clientId || credential.refresh || credential.expiresAt);

/** The demo key is no login: it stays on the device, out of DMM's store and the browser handoff. */
const withoutDemo = (credentials: Credentials): Credentials =>
	Object.fromEntries(Object.entries(credentials).filter(([, credential]) => !isDemoToken(credential?.token))) as Credentials;

/** The logins DMM can verify, one per provider, as DMM web's syncIdentities builds them. */
export function identitiesFor(all: Credentials): SyncIdentity[] {
	const credentials = withoutDemo(all);
	const identities: SyncIdentity[] = [];
	for (const provider of PROVIDERS) {
		const credential = credentials[provider];
		if (!credential?.token && !credential?.refresh) continue;
		if (provider === 'rd' && credential.clientId && credential.clientSecret && credential.refresh) {
			identities.push({ service: 'rd', clientId: credential.clientId, clientSecret: credential.clientSecret, refreshToken: credential.refresh });
		} else if (credential.token) identities.push({ service: provider, apiKey: credential.token });
	}
	return identities;
}

const json = (value: string | number) => JSON.stringify(value);
const expiring = (value: string, expiresAt?: number) => (expiresAt ? JSON.stringify({ value, expiry: expiresAt }) : JSON.stringify(value));

/** The app's logins and settings under DMM web's keys and in its formats. */
export function stateFromApp(all: Credentials, settings: AppSettings): BrowserState {
	const credentials = withoutDemo(all);
	const state: BrowserState = {};
	const rd = credentials.rd;
	if (rd?.clientId && rd.clientSecret && rd.refresh) {
		// DMM web mints its own access token from these, as the app does.
		Object.assign(state, { 'rd:clientId': json(rd.clientId), 'rd:clientSecret': json(rd.clientSecret), 'rd:refreshToken': json(rd.refresh) });
	} else if (rd?.token) state['rd:accessToken'] = json(rd.token);
	for (const provider of ['ad', 'tb', 'oc'] as const) {
		const token = credentials[provider]?.token;
		if (token) state[`${provider}:apiKey`] = json(token);
	}
	const pm = credentials.pm;
	if (pm?.token) state[isDeviceLogin(pm) ? 'pm:accessToken' : 'pm:apiKey'] = json(pm.token);
	const dl = credentials.dl;
	if (dl?.token && isDeviceLogin(dl)) {
		state['dl:accessToken'] = expiring(dl.token, dl.expiresAt);
		if (dl.refresh) state['dl:refreshToken'] = json(dl.refresh);
		if (dl.expiresAt) state['dl:tokenExpiry'] = json(dl.expiresAt);
	} else if (dl?.token) state['dl:apiKey'] = json(dl.token);
	for (const name of Object.keys(SETTINGS) as SettingName[]) {
		const value = settings[name];
		// DMM web's players are "<os>/<app>"; it sends the app's own ('builtin', 'browser') to /api/watch/resolve/builtin, a 404.
		if (value && (name !== 'player' || value.includes('/'))) state[SETTINGS[name].webKey] = value;
	}
	return state;
}

/** A stored string as DMM web keeps it: raw, JSON-quoted, or an unexpired `{ value, expiry }`. */
export function readValue(raw: string | undefined): string | null {
	if (raw === undefined) return null;
	try {
		const parsed = JSON.parse(raw);
		if (typeof parsed === 'string') return parsed || null;
		if (typeof parsed === 'number') return String(parsed);
		if (parsed && typeof parsed.value === 'string') {
			if (typeof parsed.expiry === 'number' && parsed.expiry < Date.now()) return null;
			return parsed.value || null;
		}
		return null;
	} catch {
		return raw || null;
	}
}

/** The logins a saved state holds, in the app's shape. A Real-Debrid device login still needs a token minted. */
export function credentialsFromState(state: BrowserState): Credentials {
	const read = (key: string) => readValue(state[key]);
	const found: Credentials = {};
	const [clientId, clientSecret, refresh] = [read('rd:clientId'), read('rd:clientSecret'), read('rd:refreshToken')];
	if (clientId && clientSecret && refresh) found.rd = { token: '', clientId, clientSecret, refresh, expiresAt: 1 };
	else if (read('rd:accessToken')) found.rd = { token: read('rd:accessToken')! };
	for (const provider of ['ad', 'tb', 'oc'] as const) {
		const key = read(`${provider}:apiKey`);
		if (key) found[provider] = { token: key };
	}
	const pmToken = read('pm:accessToken');
	if (pmToken) found.pm = { token: pmToken, expiresAt: Date.now() + 10 * 365 * 24 * 3600 * 1000 };
	else if (read('pm:apiKey')) found.pm = { token: read('pm:apiKey')! };
	const dlRefresh = read('dl:refreshToken');
	const dlToken = read('dl:accessToken');
	if (dlRefresh) found.dl = { token: dlToken ?? '', refresh: dlRefresh, expiresAt: dlToken ? Number(read('dl:tokenExpiry')) || 1 : 1 };
	else if (read('dl:apiKey')) found.dl = { token: read('dl:apiKey')! };
	return found;
}

/** The settings a saved state holds that this app understands. */
export function settingsFromState(state: BrowserState): AppSettings {
	const found: AppSettings = {};
	for (const name of Object.keys(SETTINGS) as SettingName[]) {
		const value = readValue(state[SETTINGS[name].webKey]);
		if (value) found[name] = value;
	}
	return found;
}

/**
 * What to save: everything DMM web keeps that the app does not use rides along untouched,
 * the logins of providers removed in the app are dropped, and the app's own values win.
 */
export function mergeState(remote: BrowserState, app: BrowserState, removed: Iterable<ProviderId | 'trakt'>): BrowserState {
	const merged = { ...remote };
	for (const login of removed) for (const key of LOGIN_KEYS[login]) delete merged[key];
	for (const key of Object.keys(app)) {
		// An app login replaces the provider's every key, so a pasted key never sits beside stale OAuth data.
		const login = (Object.keys(LOGIN_KEYS) as (keyof typeof LOGIN_KEYS)[]).find((id) => key.startsWith(`${id}:`));
		if (login) for (const stale of LOGIN_KEYS[login]) if (!(stale in app)) delete merged[stale];
	}
	return { ...merged, ...app };
}

export interface BrowserStateApi {
	restore(identity: SyncIdentity): Promise<BrowserState | null>;
	save(identities: SyncIdentity[], state: BrowserState): Promise<void>;
}

async function send(method: 'POST' | 'PUT', body: unknown): Promise<Response> {
	return fetch(`${DMM_ORIGIN}/api/browser-state`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

export const browserStateApi: BrowserStateApi = {
	async restore(identity) {
		const res = await send('POST', { identity });
		if (res.status === 204) return null;
		if (res.status !== 200) throw new Error(`DMM answered ${res.status} for the saved logins.`);
		const body = (await res.json()) as { state?: BrowserState };
		return body.state ?? null;
	},
	async save(identities, state) {
		const res = await send('PUT', { identities, state });
		if (!res.ok) throw new Error(`DMM answered ${res.status} when saving logins.`);
	},
};
