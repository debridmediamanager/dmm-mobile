import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	_testing,
	needsRenewal,
	parseCredential,
	renewCredential,
	serializeCredential,
	startDeviceLogin,
	waitForApproval,
	type DeviceLogin,
	type PollResult,
} from './auth';
import rdCode from './test/fixtures/oauth/rd-code-2026-11-09.json';
import rdPending from './test/fixtures/oauth/rd-cred-pending-2026-11-09.json';
import adPin from './test/fixtures/oauth/ad-pin-2026-11-09.json';
import adPending from './test/fixtures/oauth/ad-check-pending-2026-11-09.json';
import pmCode from './test/fixtures/oauth/pm-code-2026-11-09.json';
import pmPending from './test/fixtures/oauth/pm-pending-2026-11-09.json';
import dlCode from './test/fixtures/oauth/dl-code-2026-11-09.json';
import dlPending from './test/fixtures/oauth/dl-pending-2026-11-09.json';

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Answers each request with the next queued response and records what was sent. */
const queue = (...responses: Response[]) => {
	const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
		const next = responses.shift();
		if (!next) throw new Error('unexpected request');
		return next;
	});
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
};
const sent = (call: unknown[]) => new URLSearchParams(String((call[1] as RequestInit | undefined)?.body ?? ''));

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe('Real-Debrid device login', () => {
	it('opens the direct approval URL and keeps polling through the 403 an unapproved code gets', async () => {
		const fetchMock = queue(json(rdCode), json(rdPending.body, rdPending.status));
		const login = await startDeviceLogin('rd');
		expect(login.userCode).toBe(rdCode.user_code);
		expect(login.verificationUrl).toBe(rdCode.direct_verification_url);
		expect(String(fetchMock.mock.calls[0][0])).toContain(`client_id=${_testing.RD_CLIENT_ID}&new_credentials=yes`);
		await expect(login.poll()).resolves.toBe('pending');
	});

	it('exchanges approved credentials for a token that renews with the device code', async () => {
		const fetchMock = queue(json(rdCode), json({ client_id: 'CID', client_secret: 'SECRET' }), json({ access_token: 'ACCESS', expires_in: 86400, refresh_token: 'R' }));
		const login = await startDeviceLogin('rd');
		const credential = await login.poll();
		expect(credential).toMatchObject({ token: 'ACCESS', refresh: rdCode.device_code, clientId: 'CID', clientSecret: 'SECRET' });
		expect((credential as { expiresAt: number }).expiresAt).toBeGreaterThan(Date.now() + 86_000_000);
		const exchange = sent(fetchMock.mock.calls[2]);
		expect(exchange.get('code')).toBe(rdCode.device_code);
		expect(exchange.get('grant_type')).toBe(_testing.DEVICE_GRANT);
	});
});

describe('AllDebrid PIN login', () => {
	it('polls pin/check with the pin and check hash until it hands back an API key', async () => {
		const fetchMock = queue(json(adPin), json(adPending), json({ status: 'success', data: { activated: true, apikey: 'ADKEY', expires_in: 500 } }));
		const login = await startDeviceLogin('ad');
		expect(login.userCode).toBe(adPin.data.pin);
		expect(login.verificationUrl).toBe(adPin.data.user_url);
		await expect(login.poll()).resolves.toBe('pending');
		expect(Object.fromEntries(sent(fetchMock.mock.calls[1]))).toEqual({ pin: adPin.data.pin, check: adPin.data.check });
		await expect(login.poll()).resolves.toEqual({ token: 'ADKEY' });
	});

	it('ends on an expired PIN', async () => {
		queue(json(adPin), json({ status: 'error', error: { code: 'PIN_EXPIRED', message: 'expired' } }));
		const login = await startDeviceLogin('ad');
		await expect(login.poll()).rejects.toMatchObject({ code: 'expired_token' });
	});
});

describe('Premiumize device login', () => {
	it('treats the 400 authorization_pending as pending and returns a key-shaped token', async () => {
		const fetchMock = queue(json(pmCode), json(pmPending.body, pmPending.status), json({ error: 'slow_down' }, 400), json({ access_token: 'PMTOKEN', token_type: 'bearer', expires_in: 315360000 }));
		const login = await startDeviceLogin('pm');
		expect(login.verificationUrl).toBe(pmCode.verification_uri);
		expect(sent(fetchMock.mock.calls[0]).get('client_id')).toBe(_testing.PM_CLIENT_ID);
		await expect(login.poll()).resolves.toBe('pending');
		await expect(login.poll()).resolves.toBe('slow_down');
		const credential = await login.poll();
		// Ten years, no refresh grant: stored like a pasted key.
		expect(credential).toEqual({ token: 'PMTOKEN' });
		expect(serializeCredential(credential as { token: string })).toBe('PMTOKEN');
	});

	it('reports a declined request', async () => {
		queue(json(pmCode), json({ error: 'access_denied' }, 400));
		const login = await startDeviceLogin('pm');
		await expect(login.poll()).rejects.toThrow('You declined the request on Premiumize.');
	});
});

describe('Debrid-Link device login', () => {
	it('asks for the delete scope and keeps the refresh token and expiry', async () => {
		const fetchMock = queue(json(dlCode), json(dlPending.body, dlPending.status), json({ access_token: 'DLA', refresh_token: 'DLR', expires_in: 86400 }));
		const login = await startDeviceLogin('dl');
		expect(login.verificationUrl).toBe(dlCode.verification_url);
		expect(login.interval).toBe(dlCode.interval);
		expect(sent(fetchMock.mock.calls[0]).get('scope')).toBe(_testing.DL_SCOPES);
		await expect(login.poll()).resolves.toBe('pending');
		const credential = await login.poll();
		expect(credential).toMatchObject({ token: 'DLA', refresh: 'DLR' });
	});

	it('keeps the old refresh token when a renewal does not rotate it', async () => {
		const fetchMock = queue(json({ access_token: 'NEW', expires_in: 86400 }));
		const renewed = await renewCredential('dl', { token: 'OLD', refresh: 'DLR', expiresAt: 1 });
		expect(renewed).toMatchObject({ token: 'NEW', refresh: 'DLR' });
		expect(sent(fetchMock.mock.calls[0]).get('grant_type')).toBe('refresh_token');
	});

	it('asks for a new sign-in when renewal is refused', async () => {
		queue(json({ error: 'invalid_grant' }, 400));
		await expect(renewCredential('dl', { token: 'OLD', refresh: 'DLR', expiresAt: 1 })).rejects.toMatchObject({ code: 'renew_failed' });
	});
});

describe('stored credentials', () => {
	it('reads a bare pasted key exactly as before', () => {
		expect(parseCredential('ABC123')).toEqual({ token: 'ABC123' });
		expect(parseCredential('{not json')).toEqual({ token: '{not json' });
	});

	it('round-trips a renewable credential and flags it five minutes before expiry', () => {
		const credential = { token: 'T', refresh: 'R', clientId: 'C', clientSecret: 'S', expiresAt: 1_000_000_000 };
		expect(parseCredential(serializeCredential(credential))).toEqual(credential);
		expect(needsRenewal(credential, 1_000_000_000 - 6 * 60_000)).toBe(false);
		expect(needsRenewal(credential, 1_000_000_000 - 4 * 60_000)).toBe(true);
		expect(needsRenewal({ token: 'key' }, Number.MAX_SAFE_INTEGER)).toBe(false);
	});
});

describe('waiting for approval', () => {
	const login = (results: Array<PollResult | Error>, interval = 5, expiresIn = 600): DeviceLogin => ({
		provider: 'pm',
		userCode: 'code',
		verificationUrl: 'https://example.invalid',
		expiresIn,
		interval,
		poll: vi.fn(async () => {
			const next = results.shift();
			if (next instanceof Error) throw next;
			return next ?? 'pending';
		}),
	});

	it('backs off on slow_down and survives a dropped connection', async () => {
		vi.useFakeTimers();
		const { DeviceLoginError } = await import('./auth');
		const flow = login(['slow_down', new DeviceLoginError('offline', 'network'), { token: 'T' }]);
		const result = waitForApproval(flow, new AbortController().signal);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(flow.poll).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(flow.poll).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(flow.poll).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(10_000);
		await expect(result).resolves.toEqual({ token: 'T' });
	});

	it('resolves null when cancelled and fails once the code expires', async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const cancelled = waitForApproval(login([]), controller.signal);
		controller.abort();
		await expect(cancelled).resolves.toBeNull();

		const expired = waitForApproval(login([], 5, 12), new AbortController().signal);
		const assertion = expect(expired).rejects.toMatchObject({ code: 'expired_token' });
		await vi.advanceTimersByTimeAsync(20_000);
		await assertion;
	});
});
