import type { LibraryItem, MediaType, ProviderId, SortMode } from './model';

/** DMM web's library status filters (`?status=`), plus 'all'. */
export type LibraryView = 'all' | 'inprogress' | 'slow' | 'failed' | 'uncached' | 'rdblocked' | 'samehash' | 'sametitle' | 'selected';

export interface LibraryQuery {
	search: string;
	provider: ProviderId | 'all';
	view: LibraryView;
	media: MediaType | 'all';
	sort: SortMode;
	/** One title group (a "N same title" chip). */
	titleKey?: string;
	/** One provider:hash group (a "N same hash" chip). */
	hashKey?: string;
	selected?: ReadonlySet<string>;
}

export const EMPTY_QUERY: LibraryQuery = {
	search: '',
	provider: 'all',
	view: 'all',
	media: 'all',
	sort: 'newest',
};

const VIDEO = /\.(mkv|mp4|avi|m4v|mov|wmv|ts|m2ts|webm|mpg|mpeg|flv|vob|iso)$/i;
export const isVideoName = (name: string): boolean => VIDEO.test(name);

const mediaTypes = new WeakMap<object, MediaType>();
const titleKeys = new WeakMap<object, string>();

/** DMM web's getTypeByNameAndFileCount, then 'other' when the known files hold no video. Cached per row. */
export function mediaTypeOf(item: Pick<LibraryItem, 'filename' | 'files'>): MediaType {
	let type = mediaTypes.get(item);
	if (!type) mediaTypes.set(item, (type = guessMediaType(item)));
	return type;
}

function guessMediaType(item: Pick<LibraryItem, 'filename' | 'files'>): MediaType {
	if (item.files.length > 0 && !item.files.some((file) => isVideoName(file.name))) return 'other';
	const name = item.filename;
	return /(season|episode)s?.?\d/i.test(name) ||
		/[se]\d\d/i.test(name) ||
		/\b(tv|complete)/i.test(name) ||
		/\b(saison|stage).?\d/i.test(name) ||
		/[a-z]\s?-\s?\d{2,4}\b/.test(name) ||
		/\d{2,4}\s?-\s?\d{2,4}\b/.test(name)
		? 'tv'
		: 'movie';
}

export const normalizeTitle = (value: string): string =>
	value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/**
 * The release's title: the name up to its year, season or resolution tag.
 * ponytail: web parses with video-filename-parser; this cut agrees on scene names but
 * can split oddly named releases into separate groups. Port the parser if that shows.
 */
export function parsedTitle(filename: string): string {
	const spaced = filename.replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[._]+/g, ' ');
	const cut = spaced.search(/[\s([]((19|20)\d{2}|s\d{1,2}(e\d{1,3})?|season\s?\d+|\d{3,4}p|complete)\b/i);
	return normalizeTitle(cut > 0 ? spaced.slice(0, cut) : spaced) || normalizeTitle(filename);
}

/** What DMM web adds to a title: a film's year, a show's season and episode ("Title ➡️ S03E09"). */
function titleSuffix(filename: string, mediaType: MediaType): string {
	if (mediaType === 'movie') return filename.match(/\b(19|20)\d{2}\b/)?.[0] ?? '';
	const episode = filename.match(/\bs(\d{1,2})[\s.]?e(\d{1,3})/i);
	if (episode) return `s${Number(episode[1])}e${Number(episode[2])}`;
	const season = filename.match(/\bs(\d{1,2})\b/i) ?? filename.match(/\bseason[\s.]?(\d{1,2})/i);
	return season ? `s${Number(season[1])}` : '';
}

export const titleKeyOf = (item: LibraryItem): string => {
	let key = titleKeys.get(item);
	if (key === undefined) {
		const mediaType = mediaTypeOf(item);
		titleKeys.set(item, (key = `${mediaType}:${parsedTitle(item.filename)}:${titleSuffix(item.filename, mediaType)}`));
	}
	return key;
};

/** Same-hash identity is per provider: one copy each on RD and PM is not a duplicate. */
export const hashKeyOf = (item: Pick<LibraryItem, 'provider' | 'hash'>): string => `${item.provider}:${item.hash}`;

export interface LibraryGrouping {
	titleCounts: Map<string, number>;
	hashCounts: Map<string, number>;
	/** Bytes with each provider:hash counted once. */
	totalBytes: number;
}

export function groupLibrary(items: readonly LibraryItem[]): LibraryGrouping {
	const titleCounts = new Map<string, number>();
	const hashCounts = new Map<string, number>();
	let totalBytes = 0;
	for (const item of items) {
		// A hash-only placeholder name says nothing about the title.
		if (!/^magnet/i.test(item.filename)) {
			const key = titleKeyOf(item);
			titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1);
		}
		if (!item.hash) {
			totalBytes += item.size;
			continue;
		}
		const key = hashKeyOf(item);
		const count = (hashCounts.get(key) ?? 0) + 1;
		hashCounts.set(key, count);
		if (count === 1) totalBytes += item.size;
	}
	return { titleCounts, hashCounts, totalBytes };
}

// Real-Debrid's filename filter, re-measured 2026-10-14 (DMM web src/utils/deInfringe.ts).
const RD_BLOCKED_EXACT_CASE = /WEB-DL|WEB\.(?:x264|H264)/;
const RD_BLOCKED_ANY_CASE = /(?:web|bd|hd|dvd)rip|bluray\.x264|p\.bluray\.dts|hdtv\.(?:x264|xvid)/i;
export const isRdBlockedName = (name: string): boolean => RD_BLOCKED_EXACT_CASE.test(name) || RD_BLOCKED_ANY_CASE.test(name);

const SLOW_AFTER_MS = 20 * 60 * 1000;

/** Downloading for 20 minutes with no seeders. A web download has no swarm, so it is never slow. */
export function isSlow(item: LibraryItem, now = Date.now()): boolean {
	if (item.kind === 'web' || item.status !== 'downloading' || item.seeders !== 0) return false;
	// ponytail: RD's "Z" timestamps are Paris wall time; web corrects that, here an RD row reads up to 2 h younger.
	return now - new Date(item.added).getTime() >= SLOW_AFTER_MS;
}

const isInProgress = (item: LibraryItem): boolean => item.status === 'downloading' || item.status === 'waiting';

/** DMM web's quickSearchLibrary: every space-separated word must match the filename (as a regex), id, hash or provider status. */
export function searchMatcher(query: string): (item: LibraryItem) => boolean {
	const words = query.split(' ').filter(Boolean).map((word) => {
		const q = word.toLowerCase();
		let pattern: RegExp | null = null;
		try {
			pattern = new RegExp(q, 'i');
		} catch {
			pattern = null;
		}
		return { q, pattern };
	});
	return (item) => {
		const providerId = item.id.slice(item.id.indexOf(':') + 1).toLowerCase();
		return words.every(({ q, pattern }) =>
			`${item.provider}:` === q || item.provider === q || providerId === q || item.hash === q || item.serviceStatus.toLowerCase() === q ||
			(pattern !== null && (pattern.test(item.filename) || pattern.test(item.title)))
		);
	};
}

export const matchesSearch = (item: LibraryItem, query: string): boolean => searchMatcher(query)(item);

export function filterAndSortLibrary(
	items: readonly LibraryItem[],
	query: LibraryQuery,
	grouping: LibraryGrouping = groupLibrary(items),
	now = Date.now()
): LibraryItem[] {
	const search = query.search.trim();
	const matches = search ? searchMatcher(search) : null;
	const filtered = items.filter((item) => {
		if (query.provider !== 'all' && item.provider !== query.provider) return false;
		if (query.media !== 'all' && mediaTypeOf(item) !== query.media) return false;
		if (query.titleKey && titleKeyOf(item) !== query.titleKey) return false;
		if (query.hashKey && hashKeyOf(item) !== query.hashKey) return false;
		switch (query.view) {
			case 'inprogress':
				if (!isInProgress(item)) return false;
				break;
			case 'slow':
				if (!isSlow(item, now)) return false;
				break;
			case 'failed':
				if (item.status !== 'error') return false;
				break;
			case 'uncached':
				if (!item.uncached) return false;
				break;
			case 'rdblocked':
				if (item.provider !== 'rd' || !isRdBlockedName(item.filename)) return false;
				break;
			case 'samehash':
				if (!item.hash || (grouping.hashCounts.get(hashKeyOf(item)) ?? 0) < 2) return false;
				break;
			case 'sametitle':
				if ((grouping.titleCounts.get(titleKeyOf(item)) ?? 0) < 2) return false;
				break;
			case 'selected':
				if (!query.selected?.has(item.id)) return false;
				break;
		}
		return !matches || matches(item);
	});

	return filtered.sort((a, b) => {
		switch (query.sort) {
			case 'title':
				return a.title.localeCompare(b.title);
			case 'size':
				return b.size - a.size || a.title.localeCompare(b.title);
			case 'progress':
				return a.progress - b.progress || a.title.localeCompare(b.title);
			case 'oldest':
				return new Date(a.added).getTime() - new Date(b.added).getTime();
			default:
				return new Date(b.added).getTime() - new Date(a.added).getTime();
		}
	});
}

export type DuplicateRule = 'smaller' | 'bigger' | 'older' | 'newer';

/** For each title group, keep one row and return the rest. `rule` names what gets deleted. */
export function duplicatesToDelete(items: readonly LibraryItem[], rule: DuplicateRule): LibraryItem[] {
	const keep = new Map<string, LibraryItem>();
	const doomed: LibraryItem[] = [];
	const time = (item: LibraryItem) => new Date(item.added).getTime();
	// true when the candidate should be kept instead of the current keeper
	const prefer: Record<DuplicateRule, (kept: LibraryItem, candidate: LibraryItem) => boolean> = {
		smaller: (kept, candidate) => candidate.size > kept.size,
		bigger: (kept, candidate) => candidate.size < kept.size,
		older: (kept, candidate) => time(candidate) > time(kept),
		newer: (kept, candidate) => time(candidate) < time(kept),
	};
	for (const item of items) {
		const key = titleKeyOf(item);
		const kept = keep.get(key);
		if (!kept) keep.set(key, item);
		else if (prefer[rule](kept, item)) {
			doomed.push(kept);
			keep.set(key, item);
		} else doomed.push(item);
	}
	return doomed;
}

/** Finished rows sharing a hash on one provider: the last of each group is reinserted, the rest deleted. */
export function sameHashMergeGroups(items: readonly LibraryItem[]): LibraryItem[][] {
	const groups = new Map<string, LibraryItem[]>();
	for (const item of items) {
		if (!item.hash || item.status !== 'finished') continue;
		const key = hashKeyOf(item);
		groups.set(key, [...(groups.get(key) ?? []), item]);
	}
	return [...groups.values()].filter((group) => group.length > 1);
}

export interface BulkResult {
	done: number;
	failed: { label: string; message: string }[];
}

/** Runs `work` over `entries` four at a time, as DMM web's bulk actions do. */
export async function runBulk<T>(
	entries: readonly T[],
	work: (entry: T) => Promise<void>,
	label: (entry: T) => string,
	onProgress?: (finished: number, total: number) => void,
	concurrency = 4
): Promise<BulkResult> {
	const result: BulkResult = { done: 0, failed: [] };
	let next = 0;
	let finished = 0;
	const worker = async () => {
		while (next < entries.length) {
			const entry = entries[next++];
			try {
				await work(entry);
				result.done++;
			} catch (error) {
				result.failed.push({ label: label(entry), message: error instanceof Error ? error.message : 'The provider request failed.' });
			}
			onProgress?.(++finished, entries.length);
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker));
	return result;
}

export const transferItems = (items: readonly LibraryItem[]): LibraryItem[] =>
	items.filter(
		(item) => item.status === 'waiting' || item.status === 'downloading' || item.status === 'error'
	);

export const formatBytes = (bytes: number): string => {
	if (!Number.isFinite(bytes) || bytes <= 0) return 'Unknown size';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
	return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
};

export const formatAgo = (since: number, now = Date.now()): string => {
	const seconds = Math.max(0, Math.round((now - since) / 1000));
	if (seconds < 60) return 'just now';
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
};

export const filePath = (name: string, path?: string): string =>
	path ? `${path.replace(/^\/+|\/+$/g, '')}/${name}` : name;
