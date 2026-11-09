import lzString from 'lz-string';
import type { LibraryItem } from './model';
import { isBtih, parseBtihMagnet } from './validation';

export const DMM_ORIGIN = 'https://debridmediamanager.com';

/**
 * Rows with an info hash. A TorBox web download carries an md5 of its link, and some
 * Premiumize and Offcloud rows carry none; those resolve to nothing when shared.
 */
export const shareableItems = (items: readonly LibraryItem[]): LibraryItem[] =>
	items.filter((item) => item.kind !== 'web' && isBtih(item.hash));

/** DMM web's /hashlist page reads the list from the fragment, so no server is involved. */
export function hashlistUrl(title: string, items: readonly LibraryItem[]): string {
	const torrents = shareableItems(items).map((item) => ({ filename: item.filename, hash: item.hash, bytes: item.size }));
	return `${DMM_ORIGIN}/hashlist#${lzString.compressToEncodedURIComponent(JSON.stringify({ title, torrents }))}`;
}

/** The same `.dmm.json` shape DMM web's Local backup writes, so either side restores it. */
export const backupJson = (items: readonly LibraryItem[]): string =>
	JSON.stringify(shareableItems(items).map((item) => ({ filename: item.filename, hash: item.hash })), null, 2);

/** Hashes from a DMM web or app backup file. */
export function parseBackup(text: string): string[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error('That file is not a DMM backup (.dmm.json).');
	}
	const rows = Array.isArray(parsed) ? parsed : (parsed as { torrents?: unknown })?.torrents;
	if (!Array.isArray(rows)) throw new Error('That file is not a DMM backup (.dmm.json).');
	const hashes = rows
		.map((row) => (row && typeof row === 'object' ? String((row as { hash?: unknown }).hash ?? '') : ''))
		.map((hash) => hash.trim().toLowerCase())
		.filter(isBtih);
	return [...new Set(hashes)];
}

export type AddEntry = { kind: 'magnet'; magnet: string; hash: string } | { kind: 'hash'; hash: string } | { kind: 'url'; url: string };

/** One magnet, info hash or (TorBox) web link per line or space; anything else is reported. */
export function parseAddInput(text: string): { entries: AddEntry[]; invalid: string[] } {
	const entries: AddEntry[] = [];
	const invalid: string[] = [];
	const seen = new Set<string>();
	for (const token of text.split(/\s+/).filter(Boolean)) {
		let entry: AddEntry | null = null;
		if (/^magnet:\?/i.test(token)) {
			try {
				const parsed = parseBtihMagnet(token);
				entry = { kind: 'magnet', magnet: parsed.magnet, hash: parsed.hash };
			} catch {
				entry = null;
			}
		} else if (isBtih(token)) entry = { kind: 'hash', hash: token.toLowerCase() };
		else if (/^https?:\/\/\S+$/i.test(token)) entry = { kind: 'url', url: token };
		if (!entry) {
			invalid.push(token);
			continue;
		}
		const key = entry.kind === 'url' ? entry.url : entry.hash;
		if (seen.has(key)) continue;
		seen.add(key);
		entries.push(entry);
	}
	return { entries, invalid };
}

/** What the OS handed the app: a magnet (magnet: link or dmm-library://add?magnet=…) or a .torrent file to upload. */
export type IncomingLink = { kind: 'magnet'; magnet: string } | { kind: 'torrent'; uri: string; name: string };

export function parseIncomingLink(url: string | null | undefined): IncomingLink | null {
	if (!url) return null;
	if (/^magnet:\?/i.test(url)) return { kind: 'magnet', magnet: url };
	// Android opens a .torrent as content:// (or file://), iOS as a file:// copy in the app's Inbox.
	if (/^(content|file):\/\//i.test(url)) {
		let last = url.split(/[?#]/, 1)[0];
		try {
			last = decodeURIComponent(last);
		} catch {
			// a malformed escape keeps the raw path
		}
		last = last.split(/[/:]/).pop() ?? '';
		// A media-store id ("…/file/523") carries no file name; the providers need only some .torrent name.
		return { kind: 'torrent', uri: url, name: /\.torrent$/i.test(last) ? last : 'upload.torrent' };
	}
	const match = url.match(/[?&]magnet=([^&]+)/);
	if (!match) return null;
	try {
		return { kind: 'magnet', magnet: decodeURIComponent(match[1]) };
	} catch {
		return null;
	}
}
