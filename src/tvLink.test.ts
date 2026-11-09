import { describe, expect, it, vi } from 'vitest';
import { pollTvPairing, startTvPairing } from './tvLink';

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
