import type { BrowserState } from './sync';

/**
 * Signing a TV in the way DMM's Kodi addon links: the TV shows a code and a QR of
 * debridmediamanager.com/tv, a signed-in phone approves it there, and the TV collects
 * that browser's logins and settings once (DMM web's /api/tv/pair, /approve, /poll).
 */
export const DMM_ORIGIN = 'https://debridmediamanager.com';

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
