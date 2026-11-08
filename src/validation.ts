import type { LibraryItem } from './model';

const HEX_BTIH = /^[0-9a-f]{40}$/i;
const BASE32_BTIH = /^[a-z2-7]{32}$/i;

export interface ParsedMagnet {
	hash: string;
	magnet: string;
}

export const isBtih = (value: string): boolean => {
	const trimmed = value.trim();
	return HEX_BTIH.test(trimmed) || BASE32_BTIH.test(trimmed);
};

/** Accept only a v1 BTIH magnet. v2-only magnets are a different contract. */
export function parseBtihMagnet(input: string): ParsedMagnet {
	const value = input.trim();
	if (!/^magnet:\?/i.test(value)) throw new Error('Enter a BitTorrent magnet link.');

	let params: URLSearchParams;
	try {
		params = new URLSearchParams(value.slice(value.indexOf('?') + 1));
	} catch {
		throw new Error('The magnet link is not valid.');
	}
	const xt = params
		.getAll('xt')
		.find((entry) => /^urn:btih:/i.test(entry.trim()));
	const hash = xt?.trim().slice('urn:btih:'.length) ?? '';
	if (!isBtih(hash)) throw new Error('The magnet must contain a valid v1 BTIH.');

	// Rebuild the query so malformed fragments cannot be sent to a provider,
	// while preserving a display name and tracker parameters the user supplied.
	params.delete('xt');
	const canonical = new URLSearchParams();
	canonical.append('xt', `urn:btih:${hash.toLowerCase()}`);
	for (const [key, entry] of params) canonical.append(key, entry);
	return { hash: hash.toLowerCase(), magnet: `magnet:?${canonical.toString()}` };
}

export const magnetForHash = (hash: string, name?: string): string => {
	if (!isBtih(hash)) throw new Error('No valid BTIH is available for this item.');
	const params = new URLSearchParams({ xt: `urn:btih:${hash.toLowerCase()}` });
	if (name?.trim()) params.set('dn', name.trim());
	return `magnet:?${params.toString()}`;
};

export const normalizePercent = (value: unknown): number => {
	const numeric = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(numeric)) return 0;
	return Math.max(0, Math.min(100, numeric <= 1 && numeric > 0 ? numeric * 100 : numeric));
};

export const safeNumber = (value: unknown, fallback = 0): number => {
	const numeric = typeof value === 'number' ? value : Number(value);
	return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
};

export const safeDate = (value: unknown): string => {
	const date = value instanceof Date
		? new Date(value.getTime())
		: typeof value === 'string' || typeof value === 'number'
			? new Date(value)
			: new Date(Number.NaN);
	return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
};

export const isSafeExternalUrl = (value: unknown): value is string => {
	if (typeof value !== 'string' || !value.trim()) return false;
	try {
		const protocol = new URL(value).protocol;
		return protocol === 'http:' || protocol === 'https:';
	} catch {
		return false;
	}
};

/** Keep user-visible titles useful even when a provider gives a hash-only row. */
export const displayName = (value: unknown, fallback = 'Unnamed transfer'): string => {
	if (typeof value !== 'string') return fallback;
	const trimmed = value.trim();
	return trimmed || fallback;
};

export const isTransfer = (item: LibraryItem): boolean =>
	item.status === 'waiting' || item.status === 'downloading' || item.status === 'error';
