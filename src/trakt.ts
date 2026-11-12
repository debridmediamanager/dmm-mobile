import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { readValue, type BrowserState } from './sync';
import { DMM_ORIGIN } from './tvLink';

/**
 * The Trakt login. DMM web's (its synced `trakt:*` keys) is used as it is; without one the app links
 * with a device code. Both go through DMM's Trakt app: DMM keeps its client secret and renews tokens
 * (/api/kodi/tracker/*, as the Kodi addon does), the app then calls Trakt itself.
 */
export const TRAKT_API = 'https://api.trakt.tv';
/** DMM's Trakt app id, public (DMM web and the Kodi addon ship it). Tokens only renew with the app that issued them. */
export const TRAKT_CLIENT_ID = '8a7455d06804b07fa25e27454706c6f2107b6fe5ed2ad805eff3b456a17e79f0';

export interface TraktLogin {
	accessToken: string;
	/** Single use: every renewal returns a new one and the old one stops working. */
	refreshToken: string;
	/** Milliseconds; 1 when only the refresh token is known. */
	expiresAt: number;
	slug?: string;
}

export const TRAKT_KEYS = ['trakt:accessToken', 'trakt:refreshToken', 'trakt:userSlug'];

/** DMM web's Trakt login: the access token in useLocalStorage's `{ value, expiry }`, the others JSON strings. An expired token still has its refresh token. */
export function loginFromState(state: BrowserState): TraktLogin | null {
	const refreshToken = readValue(state['trakt:refreshToken']);
	if (!refreshToken) return null;
	let access: { value?: unknown; expiry?: unknown } | null = null;
	try {
		const parsed = JSON.parse(state['trakt:accessToken'] ?? 'null');
		access = typeof parsed === 'string' ? { value: parsed } : parsed;
	} catch {
		// Not DMM web's format: only the refresh token counts.
	}
	const accessToken = typeof access?.value === 'string' ? access.value : '';
	const expiresAt = accessToken && typeof access?.expiry === 'number' ? access.expiry : 1;
	const slug = readValue(state['trakt:userSlug']);
	return { accessToken, refreshToken, expiresAt, ...(slug ? { slug } : {}) };
}

/** The login under DMM web's keys, as its Trakt callback writes them, so DMM web reads what the app renewed. */
export const stateFromLogin = (login: TraktLogin): BrowserState => ({
	...(login.accessToken ? { 'trakt:accessToken': JSON.stringify({ value: login.accessToken, expiry: login.expiresAt }) } : {}),
	'trakt:refreshToken': JSON.stringify(login.refreshToken),
	...(login.slug ? { 'trakt:userSlug': JSON.stringify(login.slug) } : {}),
});

type Post = (path: string, body: Record<string, string>) => Promise<{ status: number; data: any }>;

const dmmPost: Post = async (path, body) => {
	const res = await fetch(`${DMM_ORIGIN}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
	return { status: res.status, data: await res.json().catch(() => null) };
};

const text = (value: unknown): value is string => typeof value === 'string' && value !== '';

/** DMM's answer with tokens ({ accessToken, refreshToken, expiresAt ISO }). */
function tokensOf(data: any): TraktLogin {
	const expiresAt = Date.parse(data?.expiresAt);
	if (!text(data?.accessToken) || !text(data?.refreshToken) || !expiresAt) throw new Error('DMM sent no usable Trakt token.');
	return { accessToken: data.accessToken, refreshToken: data.refreshToken, expiresAt, ...(text(data.user?.slug) ? { slug: data.user.slug } : {}) };
}

export interface TraktLink {
	/** As Trakt shows it: 8 letters. */
	userCode: string;
	deviceCode: string;
	/** auth.trakt.tv/activate/<code>: the QR, and the page a phone opens. */
	verifyUrl: string;
	interval: number;
	expiresIn: number;
}

export async function startTraktLink(post: Post = dmmPost): Promise<TraktLink> {
	const { status, data } = await post('/api/kodi/tracker/start', { service: 'trakt' });
	if (status !== 200 || !text(data?.userCode) || !text(data?.deviceCode) || !text(data?.verifyUrl)) throw new Error(data?.error || `DMM could not start linking Trakt (${status}).`);
	return { userCode: data.userCode, deviceCode: data.deviceCode, verifyUrl: data.verifyUrl, interval: Math.max(5, Number(data.interval) || 5), expiresIn: Number(data.expiresIn) || 600 };
}

/** 202 while waiting, 410 once the code expired or was denied, else the tokens and who approved. */
export async function pollTraktLink(deviceCode: string, post: Post = dmmPost): Promise<'pending' | 'expired' | TraktLogin> {
	const { status, data } = await post('/api/kodi/tracker/poll', { service: 'trakt', deviceCode });
	if (status === 202) return 'pending';
	if (status === 410) return 'expired';
	if (status === 200) return tokensOf(data);
	throw new Error(data?.error || `DMM answered ${status} while linking Trakt.`);
}

/** New tokens, or 'relink' once Trakt refuses the refresh token (it was used already, or the app was revoked). */
export async function renewTraktLogin(login: TraktLogin, post: Post = dmmPost): Promise<TraktLogin | 'relink'> {
	const { status, data } = await post('/api/kodi/tracker/refresh', { service: 'trakt', refreshToken: login.refreshToken });
	if (status === 401) return 'relink';
	if (status !== 200) throw new Error(data?.error || `DMM answered ${status} when renewing Trakt.`);
	return { ...tokensOf(data), ...(login.slug ? { slug: login.slug } : {}) };
}

interface Stored {
	login?: TraktLogin;
	/** The expiry of a login disconnected here: one DMM web still holds is not taken back, a newer one is. */
	declined?: number;
}

export interface SecretStore {
	read(): Promise<string | null>;
	write(text: string): Promise<void>;
}

const STORE_KEY = 'dmm.library.trakt';
const secureStore: SecretStore = {
	read: async () => (Platform.OS === 'web' ? null : SecureStore.getItemAsync(STORE_KEY)),
	write: async (value) => {
		if (Platform.OS !== 'web') await SecureStore.setItemAsync(STORE_KEY, value);
	},
};

/** Renewed this long before it expires; a token lasts 7 days (Trakt's docs and a live one, 2026-11-09). */
const RENEW_WITHIN_MS = 3600_000;

export interface TraktHooks {
	/** DMM's saved state for this device's logins, read fresh (null when nothing syncs). */
	pull(): Promise<BrowserState | null>;
	/** The login changed here: save it across devices now, before another device renews with a dead token. */
	changed(): void;
}

export class TraktAccount {
	private stored: Stored = {};
	private loaded: Promise<void> | null = null;
	private renewing: Promise<TraktLogin | null> | null = null;
	private readonly listeners = new Set<() => void>();
	/** Disconnected here: the next save takes the login out of DMM's store too. */
	removed = false;
	/** Trakt refused the login and DMM has no newer one: connect again. */
	refused = false;
	/** Bumped on every change, for useSyncExternalStore. */
	version = 0;

	constructor(private readonly hooks: TraktHooks, private readonly post: Post = dmmPost, private readonly store: SecretStore = secureStore, private readonly now: () => number = Date.now) {}

	load(): Promise<void> {
		this.loaded ??= this.store
			.read()
			.then((raw) => {
				if (raw) this.stored = JSON.parse(raw) as Stored;
			})
			// An unreadable item only forgets the login; DMM web's comes back on the next start.
			.catch(() => undefined)
			.then(() => this.notify());
		return this.loaded;
	}

	get login(): TraktLogin | null {
		return this.stored.login ?? null;
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

	private async save(stored: Stored): Promise<void> {
		this.stored = stored;
		this.notify();
		await this.store.write(JSON.stringify(stored));
	}

	/**
	 * Takes the login DMM web or another device saved when it is newer than this device's (a later expiry:
	 * a sign-in or renewal made since), never the one disconnected here. True when it did.
	 */
	async adopt(state: BrowserState): Promise<boolean> {
		await this.load();
		const remote = loginFromState(state);
		const local = this.stored.login;
		if (!remote || remote.refreshToken === local?.refreshToken) return false;
		if (remote.expiresAt <= Math.max(local?.expiresAt ?? 0, this.stored.declined ?? 0)) return false;
		this.removed = false;
		this.refused = false;
		await this.save({ login: { ...remote, slug: remote.slug ?? local?.slug } });
		return true;
	}

	/** What a save across devices carries. */
	state(): BrowserState {
		return this.stored.login ? stateFromLogin(this.stored.login) : {};
	}

	/** Reads DMM's saved state once, quietly, and takes a newer Trakt login from it. */
	async adoptSaved(): Promise<boolean> {
		await this.load();
		try {
			const state = await this.hooks.pull();
			return state ? await this.adopt(state) : false;
		} catch {
			return false;
		}
	}

	/** A device-code link finished. */
	async connect(login: TraktLogin): Promise<void> {
		await this.load();
		this.removed = false;
		this.refused = false;
		await this.save({ login });
		this.hooks.changed();
	}

	/** Forgets the login here and, with the next save, in DMM's store. Not revoked: DMM web may be using the same token. */
	async disconnect(): Promise<void> {
		await this.load();
		const login = this.stored.login;
		this.removed = true;
		this.refused = false;
		await this.save(login ? { declined: login.expiresAt } : {});
		this.hooks.changed();
	}

	/** Signed out of every provider: the next person signing in must not inherit this Trakt login. */
	async forget(): Promise<void> {
		await this.load();
		this.removed = false;
		this.refused = false;
		await this.save({});
	}

	/**
	 * An access token to call Trakt with, renewed in its last hour, or at once when Trakt refused it
	 * (`stale`); null when there is no usable login.
	 */
	async token(stale = false): Promise<string | null> {
		await this.load();
		const login = this.stored.login;
		if (!login) return null;
		if (!stale && login.accessToken && login.expiresAt - this.now() > RENEW_WITHIN_MS) return login.accessToken;
		this.renewing ??= this.renew(login).finally(() => (this.renewing = null));
		return (await this.renewing)?.accessToken ?? null;
	}

	private async renew(current: TraktLogin): Promise<TraktLogin | null> {
		let login = current;
		// Refresh tokens work once: when DMM web or another device renewed first, ours is dead and theirs is saved at DMM.
		if (await this.adoptSaved()) {
			if (this.usable()) return this.usable();
			login = this.stored.login!;
		}
		const renewed = await renewTraktLogin(login, this.post);
		if (renewed === 'relink') {
			if (await this.adoptSaved()) return this.usable();
			this.refused = true;
			this.notify();
			return null;
		}
		// Kept before anything else can fail: the old refresh token no longer works.
		await this.save({ login: renewed });
		this.hooks.changed();
		return renewed;
	}

	private usable(): TraktLogin | null {
		const login = this.stored.login;
		return login?.accessToken && login.expiresAt - this.now() > RENEW_WITHIN_MS ? login : null;
	}
}
