import type { BrowserState } from './sync';

/**
 * Signing a TV in the way DMM's Kodi addon links: the TV shows a code and a QR of
 * debridmediamanager.com/tv, a signed-in phone approves it there, and the TV collects
 * that browser's logins and settings once (DMM web's /api/tv/pair, /approve, /poll).
 */
export const OFFICIAL_DMM_ORIGIN = 'https://debridmediamanager.com';

/** Where every DMM call goes: debridmediamanager.com, or a self-hosted DMM set on this device (never synced). */
export let DMM_ORIGIN = OFFICIAL_DMM_ORIGIN;

export function setDmmOrigin(origin: string): void {
	DMM_ORIGIN = origin;
}

/** `dmm.example.com`, `http://192.168.1.5:3000/` → an origin; blank means debridmediamanager.com. */
export function normalizeDmmOrigin(input: string): string {
	const text = input.trim();
	if (!text) return OFFICIAL_DMM_ORIGIN;
	const match = /^(?:(https?):\/\/)?([a-z0-9.-]+|\[[0-9a-f:.]+\])(:\d{1,5})?(?:[/?#]\S*)?$/i.exec(text);
	if (!match) throw new Error('Enter the DMM server as an address like https://dmm.example.com or http://192.168.1.5:3000.');
	return `${(match[1] ?? 'https').toLowerCase()}://${match[2].toLowerCase()}${match[3] ?? ''}`;
}

/**
 * Asks a self-hosted server whether it is a DMM the app can sync with before any login goes there:
 * DMM's /api/browser-state turns down an empty body with "Missing identity", sending nothing anywhere.
 */
export async function checkDmmServer(origin: string, fetcher: Fetch = fetch as unknown as Fetch): Promise<void> {
	let res: Awaited<ReturnType<Fetch>>;
	try {
		res = await fetcher(`${origin}/api/browser-state`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
	} catch (caught) {
		throw new Error(`${origin} cannot be reached${caught instanceof Error && caught.message ? ` (${caught.message})` : ''}.`);
	}
	const body = (await res.json().catch(() => ({}))) as { error?: unknown };
	if (res.status === 400 && body.error === 'Missing identity') return;
	if (res.status === 403) throw new Error(`${origin} is a DMM too old for the app: update it to DMM from 9 November 2026 or later.`);
	throw new Error(`${origin} does not answer like a DMM server (${res.status}).`);
}

export interface TvPairing {
	/** As shown: ABCD-EFGH. */
	userCode: string;
	deviceCode: string;
	/** The QR's link; it carries the code, so a scan needs no typing. */
	verifyUrl: string;
	interval: number;
	expiresIn: number;
}

export type TvPoll = { status: 'pending' } | { status: 'expired' } | { status: 'linked'; state: BrowserState };

type Fetch = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string }) => Promise<{ status: number; json(): Promise<unknown> }>;

const post = (fetcher: Fetch, path: string, body: unknown) =>
	fetcher(`${DMM_ORIGIN}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export async function startTvPairing(fetcher: Fetch = fetch as unknown as Fetch): Promise<TvPairing> {
	const res = await post(fetcher, '/api/tv/pair', {});
	const body = (await res.json().catch(() => ({}))) as Partial<TvPairing>;
	if (res.status !== 200 || !body.userCode || !body.deviceCode || !body.verifyUrl) throw new Error(`DMM could not start linking (${res.status}). Try again in a minute.`);
	return { userCode: body.userCode, deviceCode: body.deviceCode, verifyUrl: body.verifyUrl, interval: Math.max(2, Number(body.interval) || 3), expiresIn: Number(body.expiresIn) || 600 };
}

/** 202 while waiting, the state once (200), 410 when the code expired or was already collected. */
export async function pollTvPairing(deviceCode: string, fetcher: Fetch = fetch as unknown as Fetch): Promise<TvPoll> {
	const res = await post(fetcher, '/api/tv/poll', { deviceCode });
	if (res.status === 202) return { status: 'pending' };
	if (res.status === 410) return { status: 'expired' };
	const body = (await res.json().catch(() => ({}))) as { status?: string; state?: unknown };
	if (res.status === 200 && body.status === 'linked' && body.state && typeof body.state === 'object') {
		// Only strings, as localStorage holds them; anything else is not DMM web's state.
		const state = Object.fromEntries(Object.entries(body.state as Record<string, unknown>).filter(([, value]) => typeof value === 'string')) as BrowserState;
		return { status: 'linked', state };
	}
	throw new Error(`DMM answered ${res.status} while linking.`);
}
