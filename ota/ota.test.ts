/// <reference types="node" />
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as certificates from '@expo/code-signing-certificates';
import { BASE_URL, buildManifests, signatureHeader, verifiesWith } from './publish.mjs';
import worker from './worker';

const bundle = Buffer.from('hermes bytecode');
const icon = Buffer.from('png bytes');

function fakeExport() {
	const dir = mkdtempSync(join(tmpdir(), 'ota-'));
	mkdirSync(join(dir, 'assets'));
	for (const platform of ['android', 'ios']) writeFileSync(join(dir, `${platform}.hbc`), bundle);
	writeFileSync(join(dir, 'assets', 'icon'), icon);
	const meta = (platform: string) => ({ bundle: `${platform}.hbc`, assets: [{ path: 'assets/icon', ext: 'png' }] });
	writeFileSync(join(dir, 'metadata.json'), JSON.stringify({ version: 0, bundler: 'metro', fileMetadata: { android: meta('android'), ios: meta('ios') } }));
	writeFileSync(join(dir, 'expoConfig.json'), JSON.stringify({ name: 'DMM Mobile', version: '1.0.0' }));
	return dir;
}

function signingPair() {
	const keyPair = certificates.generateKeyPair();
	const certificate = certificates.generateSelfSignedCodeSigningCertificate({ keyPair, validityNotBefore: new Date(), validityNotAfter: new Date(Date.now() + 864e5), commonName: 'test' });
	return { keyPair, certificate, privateKeyPem: certificates.convertKeyPairToPEM(keyPair).privateKeyPEM, certificatePem: certificates.convertCertificateToCertificatePEM(certificate) };
}

const base64url = (bytes: Buffer) => createHash('sha256').update(bytes).digest('base64url');

describe('buildManifests', () => {
	it('describes every file by the hash and key the app verifies', () => {
		const { manifests, files } = buildManifests(fakeExport(), '1.0.0', { createdAt: '2026-11-09T00:00:00.000Z', commit: 'abc' });
		const android = manifests.android;
		expect(android).toMatchObject({ runtimeVersion: '1.0.0', createdAt: '2026-11-09T00:00:00.000Z', metadata: {}, extra: { scopeKey: BASE_URL, commit: 'abc', expoClient: { version: '1.0.0' } } });
		expect(android.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(android.id).not.toBe(manifests.ios.id);
		expect(android.launchAsset).toEqual({ hash: base64url(bundle), key: createHash('md5').update(bundle).digest('hex'), url: `${BASE_URL}/assets/${base64url(bundle)}`, contentType: 'application/javascript' });
		expect(android.assets).toEqual([{ hash: base64url(icon), key: createHash('md5').update(icon).digest('hex'), url: `${BASE_URL}/assets/${base64url(icon)}`, fileExtension: '.png', contentType: 'image/png' }]);
		// Both platforms share the same files, stored once.
		expect([...files.keys()].sort()).toEqual([base64url(bundle), base64url(icon)].sort());
	});
});

describe('signatureHeader', () => {
	it('signs the exact bytes Expo tooling signs and verifies against the certificate', () => {
		const { keyPair, certificate, privateKeyPem, certificatePem } = signingPair();
		const body = JSON.stringify({ id: 'x' });
		const header = signatureHeader(body, privateKeyPem);
		expect(header).toBe(`sig="${certificates.signBufferRSASHA256AndVerify(keyPair.privateKey, certificate, Buffer.from(body))}", keyid="main"`);
		expect(verifiesWith(certificatePem, body, header)).toBe(true);
		expect(verifiesWith(certificatePem, body.replace('x', 'y'), header)).toBe(false);
		expect(verifiesWith(signingPair().certificatePem, body, header)).toBe(false);
	});
});

describe('worker', () => {
	const { privateKeyPem, certificatePem } = signingPair();
	const { manifests, files } = buildManifests(fakeExport(), '1.0.0');
	const store = new Map<string, string | Buffer>();
	for (const [hash] of files) store.set(`asset:${hash}`, hash === base64url(bundle) ? bundle : icon);
	for (const platform of ['android', 'ios'] as const) {
		const manifest = JSON.stringify(manifests[platform]);
		store.set(`update:1.0.0:${platform}`, JSON.stringify({ id: manifests[platform].id, manifest, signature: signatureHeader(manifest, privateKeyPem) }));
	}
	const env = {
		OTA: {
			get: async (key: string, type: string) => {
				const value = store.get(key);
				if (value === undefined) return null;
				return type === 'json' ? JSON.parse(String(value)) : new Uint8Array(value as Buffer).buffer;
			},
		},
	} as never;
	const get = (path: string, headers: Record<string, string> = {}) => worker.fetch(new Request(`${BASE_URL}${path}`, { headers }), env);

	it('serves the signed manifest for the build\'s platform and runtime version', async () => {
		const response = await get('/manifest', { 'expo-platform': 'ios', 'expo-runtime-version': '1.0.0', 'expo-protocol-version': '1' });
		expect(response.status).toBe(200);
		expect(response.headers.get('expo-protocol-version')).toBe('1');
		expect(response.headers.get('expo-sfv-version')).toBe('0');
		expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
		const body = await response.text();
		expect(JSON.parse(body).id).toBe(manifests.ios.id);
		expect(verifiesWith(certificatePem, body, response.headers.get('expo-signature')!)).toBe(true);
	});

	it('answers 204 when nothing newer exists for that build', async () => {
		const otherVersion = await get('/manifest', { 'expo-platform': 'android', 'expo-runtime-version': '0.9.0' });
		expect(otherVersion.status).toBe(204);
		expect(otherVersion.headers.get('expo-protocol-version')).toBe('1');
		const alreadyRunning = await get('/manifest', { 'expo-platform': 'android', 'expo-runtime-version': '1.0.0', 'expo-current-update-id': manifests.android.id });
		expect(alreadyRunning.status).toBe(204);
		expect((await get('/manifest', { 'expo-platform': 'android', 'expo-runtime-version': '1.0.0', 'expo-current-update-id': manifests.ios.id })).status).toBe(200);
	});

	it('refuses a request without platform and runtime version', async () => {
		expect((await get('/manifest')).status).toBe(400);
		expect((await get('/manifest', { 'expo-platform': 'web', 'expo-runtime-version': '1.0.0' })).status).toBe(400);
	});

	it('serves assets by content hash, immutable', async () => {
		const response = await get(`/assets/${base64url(bundle)}`);
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toContain('immutable');
		expect(Buffer.from(await response.arrayBuffer())).toEqual(bundle);
		expect((await get(`/assets/${base64url(Buffer.from('missing'))}`)).status).toBe(404);
		expect((await get('/assets/../update:1.0.0:ios')).status).toBe(404);
	});
});
