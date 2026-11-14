import { describe, expect, it, vi } from 'vitest';
import probe from './test/fixtures/dmm-browser-state-empty-probe-2026-11-14.json';
import { checkDmmServer, DMM_ORIGIN, normalizeDmmOrigin, OFFICIAL_DMM_ORIGIN, pollTvPairing, setDmmOrigin, startTvPairing } from './tvLink';

const reply = (status: number, body: unknown = {}) => vi.fn(async () => ({ status, json: async () => body }));

describe('linking a TV through DMM', () => {
	it('starts a pairing at DMM and keeps the code, the QR link and the poll interval', async () => {
		const fetcher = reply(200, { userCode: 'ABCD-EFGH', deviceCode: 'd'.repeat(43), verifyUrl: 'https://debridmediamanager.com/tv?code=ABCDEFGH', interval: 3, expiresIn: 600 });
		const pairing = await startTvPairing(fetcher);
		expect(pairing).toEqual({ userCode: 'ABCD-EFGH', deviceCode: 'd'.repeat(43), verifyUrl: 'https://debridmediamanager.com/tv?code=ABCDEFGH', interval: 3, expiresIn: 600 });
		expect(fetcher).toHaveBeenCalledWith('https://debridmediamanager.com/api/tv/pair', expect.objectContaining({ method: 'POST' }));
	});

	it('says plainly when DMM cannot start one', async () => {
		await expect(startTvPairing(reply(503, { error: 'x' }))).rejects.toThrow('DMM could not start linking (503)');
	});

	it('waits on 202, stops on 410 and takes the state once, strings only', async () => {
		expect(await pollTvPairing('d', reply(202))).toEqual({ status: 'pending' });
		expect(await pollTvPairing('d', reply(410))).toEqual({ status: 'expired' });
		const linked = await pollTvPairing('d', reply(200, { status: 'linked', state: { 'ad:apiKey': '"ADKEY"', bogus: 5 } }));
		expect(linked).toEqual({ status: 'linked', state: { 'ad:apiKey': '"ADKEY"' } });
		// The device code goes in the body, never the URL.
		const fetcher = reply(202);
		await pollTvPairing('SECRET', fetcher);
		expect(fetcher).toHaveBeenCalledWith('https://debridmediamanager.com/api/tv/poll', expect.objectContaining({ body: JSON.stringify({ deviceCode: 'SECRET' }) }));
	});
});

describe('a self-hosted DMM server', () => {
	it('reads what people type as an origin, blank as debridmediamanager.com', () => {
		expect(normalizeDmmOrigin('  ')).toBe(OFFICIAL_DMM_ORIGIN);
		expect(normalizeDmmOrigin('DMM.example.com/')).toBe('https://dmm.example.com');
		expect(normalizeDmmOrigin('http://192.168.1.5:3000/library?x=1')).toBe('http://192.168.1.5:3000');
		expect(normalizeDmmOrigin('HTTPS://[fd00::5]:3000')).toBe('https://[fd00::5]:3000');
		// DMM self-hosts on plain http, so a bare LAN address means http; a domain still means https.
		expect(normalizeDmmOrigin('192.168.1.5:3000')).toBe('http://192.168.1.5:3000');
		expect(normalizeDmmOrigin('nas.local:3000')).toBe('http://nas.local:3000');
		expect(normalizeDmmOrigin('localhost:3000')).toBe('http://localhost:3000');
		expect(normalizeDmmOrigin('dmm.example.com:8443')).toBe('https://dmm.example.com:8443');
		for (const bad of ['ftp://dmm.example.com', 'javascript:alert(1)', 'dmm example.com', 'https://']) expect(() => normalizeDmmOrigin(bad)).toThrow('Enter the DMM server');
	});

	it('sends every DMM call to the server set on this device', async () => {
		setDmmOrigin('http://192.168.1.5:3000');
		try {
			const fetcher = reply(202);
			await pollTvPairing('d', fetcher);
			expect(fetcher).toHaveBeenCalledWith('http://192.168.1.5:3000/api/tv/poll', expect.anything());
		} finally {
			setDmmOrigin(OFFICIAL_DMM_ORIGIN);
		}
		expect(DMM_ORIGIN).toBe(OFFICIAL_DMM_ORIGIN);
	});

	it('takes a server only when it answers an empty sync request the way DMM does', async () => {
		const fetcher = reply(probe.status, probe.body);
		await checkDmmServer('https://dmm.example.com', fetcher);
		expect(fetcher).toHaveBeenCalledWith('https://dmm.example.com/api/browser-state', expect.objectContaining({ method: 'POST', body: '{}' }));
		await expect(checkDmmServer('https://example.com', reply(405))).rejects.toThrow('does not answer like a DMM server (405)');
		await expect(checkDmmServer('https://old.example.com', reply(403, { error: 'Forbidden' }))).rejects.toThrow('too old');
		await expect(checkDmmServer('http://10.0.0.9:3000', vi.fn(async () => Promise.reject(new Error('Network request failed'))))).rejects.toThrow('cannot be reached (Network request failed)');
	});
});
