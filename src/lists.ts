/**
 * The connected trackers' lists, read only: Trakt's watchlist, own and liked lists, Simkl's Plan to Watch and
 * other statuses. A title is a film or show by IMDb id; what the library holds of it decides what opening it does.
 */
export interface ListEntry {
	imdbId: string;
	kind: 'movie' | 'tv';
	title: string;
	year?: number;
	/** When it went on the list (ms), newest first in the Watchlist row. */
	added?: number;
}

export interface TrackerList {
	id: string;
	name: string;
	/** `watchlist` feeds Home's Watchlist row (Trakt's watchlist, Simkl's Plan to Watch). */
	kind: 'watchlist' | 'status' | 'own' | 'liked';
	items: ListEntry[];
	/** The tracker's change time of the list, so an unchanged one is not read again. */
	updatedAt?: string;
	/** Whose list a liked one is. */
	owner?: string;
}

const entry = (media: any, kind: ListEntry['kind'], added: unknown): ListEntry[] => {
	const imdbId = media?.ids?.imdb;
	if (typeof imdbId !== 'string' || !/^tt\d+$/.test(imdbId)) return [];
	const at = typeof added === 'string' ? Date.parse(added) : NaN;
	return [{ imdbId, kind, title: typeof media.title === 'string' ? media.title : imdbId, ...(Number.isInteger(media.year) ? { year: media.year } : {}), ...(at ? { added: at } : {}) }];
};

/** Trakt's watchlist or list items (movie,show): in the list's own order, titles without an IMDb id left out. */
export const traktEntries = (rows: readonly any[]): ListEntry[] => rows.flatMap((row) => (row?.movie ? entry(row.movie, 'movie', row.listed_at) : row?.show ? entry(row.show, 'tv', row.listed_at) : []));

const SIMKL_STATUSES = [
	['plantowatch', 'Plan to Watch'],
	['watching', 'Watching'],
	['hold', 'On hold'],
	['completed', 'Completed'],
	['dropped', 'Dropped'],
] as const;

/** Simkl's statuses from /sync/all-items (the answer the watched history is read from), each newest first; empty ones left out. */
export function simklLists(data: any): TrackerList[] {
	const rows: [any, ListEntry['kind'] | 'anime'][] = [
		...(data?.movies ?? []).map((row: any) => [row, 'movie']),
		...(data?.shows ?? []).map((row: any) => [row, 'tv']),
		...(data?.anime ?? []).map((row: any) => [row, 'anime']),
	];
	return SIMKL_STATUSES.flatMap(([status, name]) => {
		const items = rows
			.filter(([row]) => row?.status === status)
			.flatMap(([row, kind]) => entry(row.movie ?? row.show, kind === 'anime' ? (row.anime_type === 'movie' ? 'movie' : 'tv') : kind, row.added_to_watchlist_at))
			.sort((a, b) => (b.added ?? 0) - (a.added ?? 0));
		return items.length ? [{ id: status, name, kind: status === 'plantowatch' ? 'watchlist' : 'status', items } as TrackerList] : [];
	});
}

/** Home's Watchlist row: every tracker's watchlist, newest first, each title once; what the library holds comes first. */
export function watchlist(lists: readonly TrackerList[], held: (imdbId: string) => boolean): ListEntry[] {
	const seen = new Set<string>();
	const all = lists
		.filter((list) => list.kind === 'watchlist')
		.flatMap((list) => list.items)
		.sort((a, b) => (b.added ?? 0) - (a.added ?? 0))
		.filter((item) => !seen.has(item.imdbId) && Boolean(seen.add(item.imdbId)));
	return [...all.filter((item) => held(item.imdbId)), ...all.filter((item) => !held(item.imdbId))];
}
