// dmm-mobile-ota.bensarmiento.workers.dev: serves DMM Mobile's over-the-air updates (Expo Updates protocol v1) from KV.
// ota/publish.mjs writes `update:<runtime>:<platform>` (the signed manifest) and `asset:<sha256>` (its files).

interface KV {
	get(key: string, type: 'json'): Promise<unknown>;
	get(key: string, type: 'arrayBuffer'): Promise<ArrayBuffer | null>;
}
interface Env {
	OTA: KV;
}
interface UpdateRecord {
	id: string;
	manifest: string;
	signature: string;
}

const PROTOCOL = { 'expo-protocol-version': '1', 'expo-sfv-version': '0', 'cache-control': 'private, max-age=0' };

async function manifest(request: Request, env: Env): Promise<Response> {
	const platform = request.headers.get('expo-platform');
	const runtime = request.headers.get('expo-runtime-version');
	if ((platform !== 'android' && platform !== 'ios') || !runtime) return new Response('expo-platform and expo-runtime-version headers required', { status: 400 });
	const update = (await env.OTA.get(`update:${runtime}:${platform}`, 'json')) as UpdateRecord | null;
	// 204 = nothing newer for this build: no update published for its version yet, or it already runs this one.
	if (!update || update.id === request.headers.get('expo-current-update-id')) return new Response(null, { status: 204, headers: PROTOCOL });
	return new Response(update.manifest, { headers: { ...PROTOCOL, 'content-type': 'application/json; charset=utf-8', 'expo-signature': update.signature } });
}

async function asset(hash: string, env: Env): Promise<Response> {
	const body = await env.OTA.get(`asset:${hash}`, 'arrayBuffer');
	if (!body) return new Response('Not found', { status: 404 });
	// Named by content hash, so a cached copy never goes stale.
	return new Response(body, { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'public, max-age=31536000, immutable' } });
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
		const { pathname } = new URL(request.url);
		if (pathname === '/manifest') return manifest(request, env);
		const hash = /^\/assets\/([A-Za-z0-9_-]{43})$/.exec(pathname)?.[1];
		if (hash) return asset(hash, env);
		return new Response('Not found', { status: 404 });
	},
};
