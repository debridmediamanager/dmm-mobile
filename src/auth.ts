import type { ProviderId } from './model';

/**
 * Provider sign-in without a pasted key. Real-Debrid, Premiumize and Debrid-Link
 * use OAuth device codes, AllDebrid a PIN; TorBox and Offcloud have no such flow.
 * The client ids are the public ones DMM web uses. A native app has no CORS, so
 * it talks to the providers directly instead of through DMM's OAuth proxies.
 */

const RD_OAUTH = 'https://app.real-debrid.com/oauth/v2';
/** Real-Debrid's client for open-source apps; each device code mints its own credentials. */
const RD_CLIENT_ID = 'X245A4XAIBGVM';
const AD_BASE = 'https://api.alldebrid.com/v4.1';
const PM_TOKEN = 'https://www.premiumize.me/token';
const PM_CLIENT_ID = '713833636';
const DL_OAUTH = 'https://debrid-link.fr/api/oauth';
const DL_CLIENT_ID = '_guYLz4mr-vjcxSTfZri4w';
/** DMM deletes torrents, and Debrid-Link's default scopes leave out `delete`. */
const DL_SCOPES = 'get.account get.post.delete.seedbox get.files get.post.stream';
/** Real-Debrid and Debrid-Link name the device grant this way, not with the RFC 8628 URN. */
const DEVICE_GRANT = 'http://oauth.net/grant_type/device/1.0';
const AD_AGENT = 'DMM Mobile';
const AD_POLL_SECONDS = 5;
const RENEW_MARGIN_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 20_000;

export const DEVICE_LOGIN_PROVIDERS = ['rd', 'ad', 'pm', 'dl'] as const;
export type DeviceLoginProvider = (typeof DEVICE_LOGIN_PROVIDERS)[number];
export const supportsDeviceLogin = (provider: ProviderId): provider is DeviceLoginProvider =>
	(DEVICE_LOGIN_PROVIDERS as readonly string[]).includes(provider);

/** What the secure store holds. A pasted key is stored as the bare string, as before. */
export interface StoredCredential {
	token: string;
	/** Epoch ms after which the access token is no longer accepted. */
	expiresAt?: number;
	/** Real-Debrid: the device code; Debrid-Link: the refresh token. */
	refresh?: string;
	clientId?: string;
	clientSecret?: string;
	/** Account name shown in Accounts, so it survives a restart. */
	label?: string;
}

export const parseCredential = (raw: string): StoredCredential => {
	if (raw.startsWith('{')) {
		try {
			const value = JSON.parse(raw) as StoredCredential;
			if (typeof value.token === 'string' && value.token) return value;
		} catch {
			// Not ours: fall through and treat it as a key.
		}
	}
	return { token: raw };
};

export const serializeCredential = (credential: StoredCredential): string =>
	credential.refresh || credential.expiresAt || credential.label ? JSON.stringify(credential) : credential.token;

export const needsRenewal = (credential: StoredCredential, now = Date.now()): boolean =>
	Boolean(credential.refresh && credential.expiresAt && credential.expiresAt - RENEW_MARGIN_MS <= now);

export class DeviceLoginError extends Error {
	constructor(message: string, readonly code: string) {
		super(message);
		this.name = 'DeviceLoginError';
	}
}

type Json = Record<string, unknown>;

async function call(url: string, init: RequestInit = {}): Promise<{ status: number; body: Json }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		let response: Response;
		try {
			response = await fetch(url, { ...init, signal: controller.signal });
		} catch {
			throw new DeviceLoginError('The provider could not be reached.', 'network');
		}
		const text = await response.text();
		let body: Json = {};
		try {
			body = text.trim() ? (JSON.parse(text) as Json) : {};
		} catch {
			throw new DeviceLoginError(`The provider returned an unreadable response (${response.status}).`, 'non_json_response');
		}
		return { status: response.status, body: body && typeof body === 'object' ? body : {} };
	} finally {
		clearTimeout(timer);
	}
}

const form = (values: Record<string, string>): RequestInit => ({
	method: 'POST',
	headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
	body: new URLSearchParams(values).toString(),
});

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const num = (value: unknown, fallback: number): number =>
	typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;

const expiry = (expiresIn: unknown, now: number): number | undefined =>
	typeof expiresIn === 'number' && expiresIn > 0 ? now + expiresIn * 1000 : undefined;

/** Standard OAuth error body: pending and slow_down keep the poll going, anything else ends it. */
function oauthOutcome(body: Json, provider: string): 'pending' | 'slow_down' {
	const error = str(body.error);
	if (error === 'authorization_pending') return 'pending';
	if (error === 'slow_down') return 'slow_down';
	if (error === 'access_denied') throw new DeviceLoginError(`You declined the request on ${provider}.`, error);
	if (error === 'expired_token') throw new DeviceLoginError('That code expired before it was approved. Try again.', error);
	throw new DeviceLoginError(str(body.error_description) || error || `${provider} refused the sign-in.`, error || 'oauth_error');
}

export type PollResult = StoredCredential | 'pending' | 'slow_down';

export interface DeviceLogin {
	provider: DeviceLoginProvider;
	/** What the user types on the provider's site. */
	userCode: string;
	/** Where the user approves; may already carry the code. */
	verificationUrl: string;
	expiresIn: number;
	interval: number;
	poll(): Promise<PollResult>;
}

async function startRealDebrid(): Promise<DeviceLogin> {
	const { status, body } = await call(`${RD_OAUTH}/device/code?client_id=${RD_CLIENT_ID}&new_credentials=yes`);
	const deviceCode = str(body.device_code);
	if (status !== 200 || !deviceCode) throw new DeviceLoginError('Real-Debrid did not start a sign-in.', 'invalid_response');
	return {
		provider: 'rd',
		userCode: str(body.user_code),
		// The direct URL opens the approval page for this device without typing the code.
		verificationUrl: str(body.direct_verification_url) || str(body.verification_url) || 'https://real-debrid.com/device',
		expiresIn: num(body.expires_in, 600),
		interval: num(body.interval, 5),
		async poll() {
			// An unapproved code answers 403 with null error fields, not a pending marker.
			const credentials = await call(`${RD_OAUTH}/device/credentials?client_id=${RD_CLIENT_ID}&code=${encodeURIComponent(deviceCode)}`);
			const clientId = str(credentials.body.client_id);
			const clientSecret = str(credentials.body.client_secret);
			if (!clientId || !clientSecret) return 'pending';
			// The device code is also what renews the access token later, as in DMM web.
			return renewRealDebrid({ token: '', refresh: deviceCode, clientId, clientSecret });
		},
	};
}

async function renewRealDebrid(credential: StoredCredential, now = Date.now()): Promise<StoredCredential> {
	const { status, body } = await call(
		`${RD_OAUTH}/token`,
		form({ client_id: credential.clientId ?? '', client_secret: credential.clientSecret ?? '', code: credential.refresh ?? '', grant_type: DEVICE_GRANT })
	);
	const token = str(body.access_token);
	if (status !== 200 || !token) throw new DeviceLoginError('Real-Debrid refused to renew the sign-in. Sign in again.', 'renew_failed');
	return { ...credential, token, expiresAt: expiry(body.expires_in, now) };
}

async function startAllDebrid(): Promise<DeviceLogin> {
	// `agent` is what AllDebrid's approval page shows as the app's name.
	const { body } = await call(`${AD_BASE}/pin/get?agent=${encodeURIComponent(AD_AGENT)}`);
	const data = (body.data ?? {}) as Json;
	const pin = str(data.pin);
	const check = str(data.check);
	if (body.status !== 'success' || !pin || !check) throw new DeviceLoginError('AllDebrid did not start a sign-in.', 'invalid_response');
	return {
		provider: 'ad',
		userCode: pin,
		verificationUrl: str(data.user_url) || `https://alldebrid.com/pin/?pin=${encodeURIComponent(pin)}`,
		expiresIn: num(data.expires_in, 600),
		interval: AD_POLL_SECONDS,
		async poll() {
			const result = await call(`${AD_BASE}/pin/check`, form({ pin, check }));
			if (result.body.status !== 'success') {
				const error = (result.body.error ?? {}) as Json;
				if (error.code === 'PIN_EXPIRED') throw new DeviceLoginError('That PIN expired before it was approved. Try again.', 'expired_token');
				throw new DeviceLoginError(str(error.message) || 'AllDebrid refused the sign-in.', str(error.code) || 'oauth_error');
			}
			const checked = (result.body.data ?? {}) as Json;
			// The PIN hands back an ordinary API key: nothing to renew.
			return checked.activated === true && str(checked.apikey) ? { token: str(checked.apikey) } : 'pending';
		},
	};
}

async function startPremiumize(): Promise<DeviceLogin> {
	const { status, body } = await call(PM_TOKEN, form({ response_type: 'device_code', client_id: PM_CLIENT_ID }));
	const deviceCode = str(body.device_code);
	if (status !== 200 || !deviceCode) throw new DeviceLoginError('Premiumize did not start a sign-in.', 'invalid_response');
	return {
		provider: 'pm',
		userCode: str(body.user_code),
		verificationUrl: str(body.verification_uri) || 'https://www.premiumize.me/device',
		expiresIn: num(body.expires_in, 600),
		interval: num(body.interval, 5),
		async poll() {
			const result = await call(PM_TOKEN, form({ grant_type: 'device_code', code: deviceCode, client_id: PM_CLIENT_ID }));
			const token = str(result.body.access_token);
			// The token lasts ten years and Premiumize offers no refresh grant.
			if (result.status === 200 && token) return { token };
			return oauthOutcome(result.body, 'Premiumize');
		},
	};
}

async function startDebridLink(): Promise<DeviceLogin> {
	const { status, body } = await call(`${DL_OAUTH}/device/code`, form({ client_id: DL_CLIENT_ID, scope: DL_SCOPES }));
	const deviceCode = str(body.device_code);
	if (status !== 200 || !deviceCode) throw new DeviceLoginError('Debrid-Link did not start a sign-in.', 'invalid_response');
	return {
		provider: 'dl',
		userCode: str(body.user_code),
		verificationUrl: str(body.verification_url) || str(body.verification_uri) || 'https://debrid-link.com/device',
		expiresIn: num(body.expires_in, 900),
		interval: num(body.interval, 5),
		async poll() {
			const now = Date.now();
			const result = await call(`${DL_OAUTH}/token`, form({ client_id: DL_CLIENT_ID, code: deviceCode, grant_type: DEVICE_GRANT }));
			const token = str(result.body.access_token);
			if (result.status === 200 && token) {
				return { token, refresh: str(result.body.refresh_token) || undefined, expiresAt: expiry(result.body.expires_in, now) };
			}
			return oauthOutcome(result.body, 'Debrid-Link');
		},
	};
}

async function renewDebridLink(credential: StoredCredential, now = Date.now()): Promise<StoredCredential> {
	const { status, body } = await call(
		`${DL_OAUTH}/token`,
		form({ client_id: DL_CLIENT_ID, refresh_token: credential.refresh ?? '', grant_type: 'refresh_token' })
	);
	const token = str(body.access_token);
	if (status !== 200 || !token) throw new DeviceLoginError('Debrid-Link refused to renew the sign-in. Sign in again.', 'renew_failed');
	// Keep the old refresh token unless a rotated one arrives.
	return { ...credential, token, refresh: str(body.refresh_token) || credential.refresh, expiresAt: expiry(body.expires_in, now) };
}

export function startDeviceLogin(provider: DeviceLoginProvider): Promise<DeviceLogin> {
	switch (provider) {
		case 'rd':
			return startRealDebrid();
		case 'ad':
			return startAllDebrid();
		case 'pm':
			return startPremiumize();
		case 'dl':
			return startDebridLink();
	}
}

export function renewCredential(provider: ProviderId, credential: StoredCredential): Promise<StoredCredential> {
	if (provider === 'rd') return renewRealDebrid(credential);
	if (provider === 'dl') return renewDebridLink(credential);
	return Promise.resolve(credential);
}

const sleep = (ms: number, signal: AbortSignal) =>
	new Promise<void>((resolve) => {
		const timer = setTimeout(done, ms);
		signal.addEventListener('abort', done, { once: true });
		function done() {
			clearTimeout(timer);
			signal.removeEventListener('abort', done);
			resolve();
		}
	});

/** Polls until the user approves, the code expires or `signal` aborts (then resolves null). */
export async function waitForApproval(login: DeviceLogin, signal: AbortSignal): Promise<StoredCredential | null> {
	let interval = login.interval;
	const deadline = Date.now() + login.expiresIn * 1000;
	while (!signal.aborted && Date.now() < deadline) {
		await sleep(interval * 1000, signal);
		if (signal.aborted) return null;
		let result: PollResult;
		try {
			result = await login.poll();
		} catch (error) {
			// A dropped connection mid-wait should not cost the user the code.
			if (error instanceof DeviceLoginError && error.code === 'network') continue;
			throw error;
		}
		if (result === 'slow_down') interval += 5;
		else if (result !== 'pending') return result;
	}
	if (signal.aborted) return null;
	throw new DeviceLoginError('That code expired before it was approved. Try again.', 'expired_token');
}

export const _testing = { RD_CLIENT_ID, PM_CLIENT_ID, DL_CLIENT_ID, DL_SCOPES, DEVICE_GRANT };
