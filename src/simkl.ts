import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import app from '../app.json';
import type { TraktHttp, TraktReply } from './trackerSync';

/**
 * Simkl. DMM's Simkl app (AUTH V2) is a public client with no secret, so the app links (device code, a
 * QR on a TV), renews and calls Simkl itself. It asks for `media:read media:write`: DMM's Kodi link asks
 * for read only, and Simkl refuses every write with that grant (403 insufficient_scope, live 2026-11-12).
 * The login stays on this device: Simkl keeps one live access token per grant and a renewal cuts off the
 * previous one, so devices sharing a grant would sign each other out. DMM web's Simkl login lives in DMM's
 * server session and cannot be shared either. Each device links its own.
 */
export const SIMKL_API = 'https://api.simkl.com';
/** DMM's Simkl app id, public (DMM web, the Kodi addon). */
export const SIMKL_CLIENT_ID = 'ee604693523d56749368fc703b2467b60a2ee2531af258f689c8b9666a5d3c5b';
const WRITE = 'media:read media:write';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
/** Simkl wants the app named on every request. */
const QUERY = `client_id=${SIMKL_CLIENT_ID}&app-name=dmm-mobile&app-version=${app.expo.version}`;
const USER_AGENT = `dmm-mobile/${app.expo.version}`;

export interface SimklLogin {
	accessToken: string;
	/** Lasts 180 days from its last use, and a renewal hands the same one back. */
	refreshToken: string;
	/** Milliseconds; access tokens last 7 days. */
	expiresAt: number;
	/** As granted: "media:read" alone means nothing can be sent. */
	scope: string;
	name?: string;
}

/** A Simkl page, as the "View on Simkl" link of a title: Simkl finds it by IMDb id without a request. */
export const simklPage = (imdbId: string) => `${SIMKL_API}/redirect?to=simkl&imdb=${encodeURIComponent(imdbId)}&${QUERY}`;

export const simklHttp: TraktHttp = async (method, path, token, body) => {
	const res = await fetch(`${SIMKL_API}${path}${path.includes('?') ? '&' : '?'}${QUERY}`, {
		method,
		headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT, ...(token ? { authorization: `Bearer ${token}` } : {}) },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	const text = await res.text();
	let data: any = null;
	try {
		data = text ? JSON.parse(text) : null;
	} catch {
		// Cloudflare's pages are HTML; the status says enough.
	}
	// A scrobble while another of the user's is in flight: Simkl answers 400 RATE_LIMIT and holds a 20-second lock.
	if (res.status === 400 && /RATE_LIMIT/.test(text)) return { status: 429, data, retryAfter: 20 };
	return { status: res.status, data, retryAfter: Number(res.headers.get('retry-after')) || undefined };
};

type Call = (method: 'GET' | 'POST', path: string, body?: Record<string, string>, token?: string) => Promise<TraktReply>;
const simklCall: Call = (method, path, body, token) => simklHttp(method, path, token ?? '', body);

const text = (value: unknown): value is string => typeof value === 'string' && value !== '';

function tokensOf(data: any, now: number): SimklLogin {
	if (!text(data?.access_token) || !text(data?.refresh_token) || typeof data?.expires_in !== 'number') throw new Error('Simkl sent no usable token.');
	return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: now + data.expires_in * 1000, scope: text(data.scope) ? data.scope : 'media:read' };
}

export interface TrackerLink {
	userCode: string;
	deviceCode: string;
	/** The approve page with the code filled in: the QR, and the page a phone opens. */
	verifyUrl: string;
	/** Where to type the code by hand. */
	page: string;
	interval: number;
	expiresIn: number;
}

export async function startSimklLink(call: Call = simklCall): Promise<TrackerLink> {
	const { status, data } = await call('POST', '/oauth2/device', { client_id: SIMKL_CLIENT_ID, scope: WRITE });
	if (status !== 200 || !text(data?.device_code) || !text(data?.user_code) || !text(data?.verification_uri_complete)) throw new Error(`Simkl could not start linking (${status}).`);
	return {
		userCode: data.user_code,
		deviceCode: data.device_code,
		verifyUrl: data.verification_uri_complete,
		page: text(data.verification_uri) ? data.verification_uri.replace(/^https?:\/\//, '') : 'simkl.com/pin',
		interval: Math.max(5, Number(data.interval) || 5),
		expiresIn: Number(data.expires_in) || 900,
	};
}

/** Waiting, slow down (wait 5 s more), dead, or the login. Simkl records no denial: a declined code waits until it expires. */
export async function pollSimklLink(deviceCode: string, call: Call = simklCall, now = Date.now()): Promise<'pending' | 'slow_down' | 'expired' | SimklLogin> {
	const { status, data } = await call('POST', '/oauth2/token', { grant_type: DEVICE_GRANT, client_id: SIMKL_CLIENT_ID, device_code: deviceCode });
	if (status === 200) {
		const login = tokensOf(data, now);
		// Who linked, for Settings; the token is what matters.
		const user = await call('GET', '/users/settings', undefined, login.accessToken).catch(() => null);
		return text(user?.data?.user?.name) ? { ...login, name: user.data.user.name } : login;
	}
	if (data?.error === 'authorization_pending') return 'pending';
	if (data?.error === 'slow_down') return 'slow_down';
	if (data?.error === 'expired_token') return 'expired';
	throw new Error(`Simkl answered ${status} while linking.`);
}

/** A new access token (the refresh token comes back the same), or 'relink' once Simkl refuses the grant. */
export async function renewSimklLogin(login: SimklLogin, call: Call = simklCall, now = Date.now()): Promise<SimklLogin | 'relink'> {
	const { status, data } = await call('POST', '/oauth2/token', { grant_type: 'refresh_token', client_id: SIMKL_CLIENT_ID, refresh_token: login.refreshToken });
	if (status === 400 || status === 401) return 'relink';
	if (status !== 200) throw new Error(`Simkl answered ${status} when renewing.`);
	return { ...tokensOf(data, now), ...(login.name ? { name: login.name } : {}) };
}

export interface SecretStore {
	read(): Promise<string | null>;
	write(text: string): Promise<void>;
}

const STORE_KEY = 'dmm.library.simkl';
const secureStore: SecretStore = {
	read: async () => (Platform.OS === 'web' ? null : SecureStore.getItemAsync(STORE_KEY)),
	write: async (value) => {
		if (Platform.OS !== 'web') await SecureStore.setItemAsync(STORE_KEY, value);
	},
};

const RENEW_WITHIN_MS = 3600_000;

export class SimklAccount {
	private stored: { login?: SimklLogin } = {};
	private loaded: Promise<void> | null = null;
	private renewing: Promise<SimklLogin | null> | null = null;
	private readonly listeners = new Set<() => void>();
	/** Simkl refused the login: connect again. */
	refused = false;
	version = 0;

	constructor(private readonly call: Call = simklCall, private readonly store: SecretStore = secureStore, private readonly now: () => number = Date.now) {}

	load(): Promise<void> {
		this.loaded ??= this.store
			.read()
			.then((raw) => {
				if (raw) this.stored = JSON.parse(raw);
			})
			.catch(() => undefined)
			.then(() => this.notify());
		return this.loaded;
	}

	get login(): SimklLogin | null {
		return this.stored.login ?? null;
	}

	/** A grant without media:write: watched marks come from Simkl, nothing goes to it. */
	get readOnly(): boolean {
		return Boolean(this.stored.login && !this.stored.login.scope.split(' ').includes('media:write'));
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	getVersion = (): number => this.version;

	private notify(): void {
		this.version++;
		this.listeners.forEach((listener) => listener());
	}

	private async save(login?: SimklLogin): Promise<void> {
		this.stored = login ? { login } : {};
		this.refused = false;
		this.notify();
		await this.store.write(JSON.stringify(this.stored));
	}

	async connect(login: SimklLogin): Promise<void> {
		await this.load();
		await this.save(login);
	}

	/** Forgets the login and revokes it: the grant is this device's alone. */
	async disconnect(): Promise<void> {
		await this.load();
		const login = this.stored.login;
		await this.save();
		if (login) void this.call('POST', '/oauth2/revoke', { client_id: SIMKL_CLIENT_ID, token: login.refreshToken }).catch(() => undefined);
	}

	/** An access token, renewed in its last hour or at once when Simkl refused it (`stale`); null without a usable login. */
	async token(stale = false): Promise<string | null> {
		await this.load();
		const login = this.stored.login;
		if (!login || this.refused) return null;
		if (!stale && login.expiresAt - this.now() > RENEW_WITHIN_MS) return login.accessToken;
		this.renewing ??= this.renew(login).finally(() => (this.renewing = null));
		return (await this.renewing)?.accessToken ?? null;
	}

	private async renew(login: SimklLogin): Promise<SimklLogin | null> {
		const renewed = await renewSimklLogin(login, this.call, this.now());
		if (renewed === 'relink') {
			this.refused = true;
			this.notify();
			return null;
		}
		await this.save(renewed);
		return renewed;
	}
}
