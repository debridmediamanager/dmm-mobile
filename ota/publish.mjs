// Turns an `expo export` into signed over-the-air updates (docs/releasing.md).
//   node ota/publish.mjs build <export dir> <out dir> <runtime version>   writes manifests, signatures and assets
//   node ota/publish.mjs upload <out dir>                                 puts them in the Worker's KV, assets first
// build reads the signing key from OTA_SIGNING_KEY (PEM); upload needs CLOUDFLARE_API_TOKEN.
import { createHash, randomUUID, sign, verify, X509Certificate } from 'node:crypto';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const BASE_URL = 'https://dmm-mobile-ota.bensarmiento.workers.dev';
export const PLATFORMS = ['android', 'ios'];
const ACCOUNT_ID = '4c2342b589308b36931e9d3e129083ed';
const NAMESPACE_ID = process.env.OTA_KV_NAMESPACE_ID ?? '08e06b1d45be471294a21aa779c2edc4';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('base64url');
const md5 = (bytes) => createHash('md5').update(bytes).digest('hex');
const CONTENT_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ttf: 'font/ttf', otf: 'font/otf', json: 'application/json' };

/** One manifest per platform in the Expo Updates protocol; asset URLs are the Worker's /assets/<sha256>. */
export function buildManifests(exportDir, runtimeVersion, { createdAt = new Date().toISOString(), commit = '' } = {}) {
	const metadata = JSON.parse(readFileSync(join(exportDir, 'metadata.json'), 'utf8'));
	const expoClient = JSON.parse(readFileSync(join(exportDir, 'expoConfig.json'), 'utf8'));
	const files = new Map();
	const asset = (path, ext) => {
		const bytes = readFileSync(join(exportDir, path));
		const hash = sha256(bytes);
		files.set(hash, join(exportDir, path));
		return { hash, key: md5(bytes), url: `${BASE_URL}/assets/${hash}`, ...(ext ? { fileExtension: `.${ext}`, contentType: CONTENT_TYPES[ext] ?? 'application/octet-stream' } : { contentType: 'application/javascript' }) };
	};
	/** @type {Record<string, any>} */
	const manifests = {};
	for (const platform of PLATFORMS) {
		const meta = metadata.fileMetadata[platform];
		if (!meta) throw new Error(`The export has no ${platform} bundle; run expo export for both platforms`);
		manifests[platform] = {
			id: randomUUID(),
			createdAt,
			runtimeVersion,
			launchAsset: asset(meta.bundle),
			assets: meta.assets.map((entry) => asset(entry.path, entry.ext)),
			metadata: {},
			extra: { expoClient, scopeKey: BASE_URL, commit },
		};
	}
	return { manifests, files };
}

/** The expo-signature header value for a manifest body, verified by the certificate in certs/. */
export const signatureHeader = (body, privateKeyPem) => `sig="${sign('sha256', Buffer.from(body), privateKeyPem).toString('base64')}", keyid="main"`;

/** Whether a signature header verifies against a certificate, as the app checks it before applying an update. */
export function verifiesWith(certificatePem, body, header) {
	const sig = /sig="([^"]+)"/.exec(header)?.[1];
	return Boolean(sig) && verify('sha256', Buffer.from(body), new X509Certificate(certificatePem).publicKey, Buffer.from(sig, 'base64'));
}

function build(exportDir, outDir, runtimeVersion) {
	const key = process.env.OTA_SIGNING_KEY;
	if (!key) throw new Error('OTA_SIGNING_KEY is not set');
	if (!runtimeVersion) throw new Error('No runtime version');
	const { manifests, files } = buildManifests(exportDir, runtimeVersion, { commit: process.env.GITHUB_SHA ?? '' });
	mkdirSync(join(outDir, 'assets'), { recursive: true });
	for (const [hash, path] of files) copyFileSync(path, join(outDir, 'assets', hash));
	for (const platform of PLATFORMS) {
		const body = JSON.stringify(manifests[platform]);
		writeFileSync(join(outDir, `manifest-${platform}.json`), body);
		const header = signatureHeader(body, key);
		// A key that does not match the certificate built into the apps would have every phone refuse the update.
		if (!verifiesWith(readFileSync(new URL('../certs/certificate.pem', import.meta.url), 'utf8'), body, header)) throw new Error('OTA_SIGNING_KEY does not match certs/certificate.pem');
		writeFileSync(join(outDir, `signature-${platform}.txt`), header);
	}
	console.log(`Built ${PLATFORMS.map((p) => `${p} ${manifests[p].id}`).join(', ')} for runtime ${runtimeVersion}, ${files.size} files`);
}

async function bulkPut(entries) {
	const token = process.env.CLOUDFLARE_API_TOKEN;
	if (!token) throw new Error('CLOUDFLARE_API_TOKEN is not set');
	const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${NAMESPACE_ID}/bulk`, {
		method: 'PUT',
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
		body: JSON.stringify(entries),
	});
	const result = await response.json().catch(() => ({}));
	if (!response.ok || !result.success) throw new Error(`KV bulk write failed: ${response.status} ${JSON.stringify(result.errors ?? result)}`);
}

async function upload(outDir) {
	// Assets go first and in batches well under the 100 MB request limit; the manifests last, so no phone sees an update whose files are missing.
	let batch = [];
	let size = 0;
	for (const hash of readdirSync(join(outDir, 'assets'))) {
		const value = readFileSync(join(outDir, 'assets', hash)).toString('base64');
		if (size + value.length > 50e6 && batch.length) {
			await bulkPut(batch);
			batch = [];
			size = 0;
		}
		batch.push({ key: `asset:${hash}`, value, base64: true });
		size += value.length;
	}
	if (batch.length) await bulkPut(batch);
	const updates = PLATFORMS.map((platform) => {
		const manifest = readFileSync(join(outDir, `manifest-${platform}.json`), 'utf8');
		const { id, runtimeVersion } = JSON.parse(manifest);
		const signature = readFileSync(join(outDir, `signature-${platform}.txt`), 'utf8');
		return { key: `update:${runtimeVersion}:${platform}`, value: JSON.stringify({ id, manifest, signature }) };
	});
	await bulkPut(updates);
	console.log(`Live: ${updates.map((entry) => entry.key).join(', ')}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	const [command, ...args] = process.argv.slice(2);
	if (command === 'build') build(args[0], args[1], args[2]);
	else if (command === 'upload') await upload(args[0]);
	else throw new Error('Usage: node ota/publish.mjs build <export dir> <out dir> <runtime version> | upload <out dir>');
}
