import type { LibraryItem } from './model';
import { documentStore, MIN_RESUME_MS, playback, type PlaybackEntry, type PlaybackEvent } from './playback';
import type { CacheStore } from './titleIndex';
import { pickCopy, type EpisodeCopy, type ShowEpisodes, type TitleGroup } from './titles';

/**
 * What has been watched, per title rather than per copy: a film by its IMDb id, an episode by its
 * show's IMDb id, season and number, so any release or provider of it counts. Kept on this device
 * only; each entry is a Trakt history item (ids and when), ready to sync.
 */
export interface WatchRef {
	imdbId: string;
	season?: number;
	episode?: number;
}

export interface WatchedEntry extends WatchRef {
	watchedAt: number;
}

export const watchKey = ({ imdbId, season, episode }: WatchRef): string => (season === undefined ? imdbId : `${imdbId}:${season}:${episode}`);

const episodes = (imdbId: string, season: number, from: number, to = from): WatchRef[] => Array.from({ length: Math.max(1, to - from + 1) }, (_, n) => ({ imdbId, season, episode: from + n }));

/** What a playback save marks watched: once a file reaches 80% (FINISHED), its film or every episode it holds. Unnamed and unplaced files mark nothing. */
export function watchedFrom({ entry, ended }: PlaybackEvent): WatchRef[] {
	if (!ended || !entry.imdbId) return [];
	if (entry.kind === 'movie') return [{ imdbId: entry.imdbId }];
	if (entry.kind !== 'tv' || entry.season === undefined || entry.episode === undefined) return [];
	return episodes(entry.imdbId, entry.season, entry.episode, entry.end);
}

export class WatchStore {
	private entries: Record<string, WatchedEntry> = {};
	private loaded: Promise<void> | null = null;
	private readonly listeners = new Set<() => void>();
	/** Bumped on every change, for useSyncExternalStore. */
	version = 0;

	constructor(private readonly store: CacheStore = documentStore('watched-v1.json'), private readonly now: () => number = Date.now) {}

	load(): Promise<void> {
		this.loaded ??= this.store
			.read()
			.then((text) => {
				if (text) this.entries = JSON.parse(text) as Record<string, WatchedEntry>;
			})
			// An unreadable file forgets what was watched; nothing else depends on it.
			.catch(() => undefined)
			.then(() => this.changed());
		return this.loaded;
	}

	private changed(): void {
		this.version++;
		this.listeners.forEach((listener) => listener());
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	getVersion = (): number => this.version;

	watchedAt(ref: WatchRef): number | undefined {
		return this.entries[watchKey(ref)]?.watchedAt;
	}

	list(): WatchedEntry[] {
		return Object.values(this.entries);
	}

	/** Marks each ref watched (at `at`) or not, and saves. ponytail: unwatching deletes; Trakt sync will need it kept as a removal. */
	async set(refs: readonly WatchRef[], watched: boolean, at = this.now()): Promise<void> {
		await this.load();
		for (const { imdbId, season, episode } of refs) {
			const ref = season === undefined ? { imdbId } : { imdbId, season, episode };
			if (watched) this.entries[watchKey(ref)] = { ...ref, watchedAt: at };
			else delete this.entries[watchKey(ref)];
		}
		this.changed();
		await this.store.write(JSON.stringify(this.entries)).catch(() => undefined);
	}

	/** Records what each playback save finishes, at the time it was saved. */
	follow(source: { subscribe(listener: (event: PlaybackEvent) => void): () => void }): () => void {
		return source.subscribe((event) => {
			const refs = watchedFrom(event);
			if (refs.length) void this.set(refs, true, event.entry.updatedAt);
		});
	}
}

export const watched = new WatchStore();
watched.follow(playback);

/** A row of a show's episode list: its number, the last one a multi-episode file holds, and its copies. */
export interface HeldEpisode {
	season: number;
	episode: number;
	end: number;
	copies: EpisodeCopy[];
}

/** A season's rows, in order. */
export const seasonRows = (show: ShowEpisodes, season: number): HeldEpisode[] =>
	[...(show.seasons.get(season) ?? [])].map(([episode, copies]) => ({ season, episode, end: Math.max(episode, ...copies.map((copy) => copy.ref?.end ?? episode)), copies }));

/** The episodes the library holds, in order; specials (season 0) stay out of counts and Next Up, as on Trakt. */
export const heldEpisodes = (show: ShowEpisodes): HeldEpisode[] => [...show.seasons.keys()].filter((season) => season > 0).flatMap((season) => seasonRows(show, season));

/** "Mark watched up to here": every row before it and itself, in order; a special counts only the specials before it. */
export const rowsUpTo = (show: ShowEpisodes, row: Pick<HeldEpisode, 'season' | 'episode'>): HeldEpisode[] =>
	(row.season === 0 ? seasonRows(show, 0) : heldEpisodes(show)).filter((other) => order(other) <= order(row));

/** The refs a row marks: every episode its files hold. */
export const rowRefs = (imdbId: string, row: Pick<HeldEpisode, 'season' | 'episode' | 'end'>): WatchRef[] => episodes(imdbId, row.season, row.episode, row.end);

const order = (ref: { season?: number; episode?: number }) => (ref.season ?? 0) * 10_000 + (ref.episode ?? 0);

/** The latest resumable save per film and per episode (by watchKey), for progress bars. */
export function resumable(entries: readonly [string, PlaybackEntry][]): Map<string, PlaybackEntry> {
	const latest = new Map<string, PlaybackEntry>();
	for (const [, entry] of entries) {
		if (!entry.imdbId || entry.finished || entry.position < MIN_RESUME_MS || !entry.duration) continue;
		// A show's file DMM placed nowhere has no episode to show progress on.
		if (entry.kind === 'tv' && entry.season === undefined) continue;
		const key = watchKey(entry.season === undefined ? { imdbId: entry.imdbId } : { imdbId: entry.imdbId, season: entry.season, episode: entry.episode });
		if ((latest.get(key)?.updatedAt ?? -1) < entry.updatedAt) latest.set(key, entry);
	}
	return latest;
}

/** A save newer than the last time it was marked watched: a rewatch shows its progress, a stale one does not. */
export const progressOf = (entry: PlaybackEntry | undefined, watchedAt: number | undefined): number =>
	entry && entry.updatedAt > (watchedAt ?? -1) ? Math.min(1, entry.position / entry.duration) : 0;

export interface TitleState {
	watched: boolean;
	/** 0–1: how far into a film, or how many of a show's held episodes are watched. */
	progress: number;
	/** "3 of 10" for a show partly watched. */
	label?: string;
}

/**
 * Watched badges and progress for title cards, only for titles with anything watched or played.
 * A show counts the episodes the library holds (from the file lists read so far).
 */
export function titleStates(groups: readonly TitleGroup[], episodesOf: (group: TitleGroup) => ShowEpisodes, marks: readonly WatchedEntry[], playing: Map<string, PlaybackEntry>): Map<string, TitleState> {
	const at = new Map(marks.map((mark) => [watchKey(mark), mark.watchedAt]));
	const marked = new Set(marks.map((mark) => mark.imdbId));
	const states = new Map<string, TitleState>();
	for (const group of groups) {
		const { imdbId } = group;
		if (group.kind === 'movie') {
			const watchedAt = at.get(imdbId);
			const progress = progressOf(playing.get(imdbId), watchedAt);
			if (progress || watchedAt !== undefined) states.set(imdbId, { watched: !progress, progress });
			continue;
		}
		if (!marked.has(imdbId)) continue;
		const rows = heldEpisodes(episodesOf(group));
		const seen = rows.filter((row) => at.has(watchKey({ imdbId, season: row.season, episode: row.episode }))).length;
		if (seen === 0) continue;
		states.set(imdbId, { watched: seen === rows.length, progress: seen / rows.length, ...(seen < rows.length ? { label: `${seen} of ${rows.length}` } : {}) });
	}
	return states;
}

export interface NextUp {
	imdbId: string;
	row: HeldEpisode;
	copy: EpisodeCopy;
	/** When the episode it follows was watched: Next Up lists the latest first. */
	after: number;
}

/**
 * The episode to watch next: the first held one after the episode watched last (by time, then the
 * highest of those marked together, as a whole season is) that is not watched yet. It looks forward
 * only, and never at specials. Its copy comes from the release played before when it can.
 */
export function nextUp(imdbId: string, show: ShowEpisodes, marks: readonly WatchedEntry[], before?: Pick<LibraryItem, 'id' | 'provider'>): NextUp | null {
	const seen = new Set<string>();
	let last: WatchedEntry | undefined;
	for (const mark of marks) {
		if (mark.imdbId !== imdbId) continue;
		seen.add(watchKey(mark));
		if (!mark.season || mark.episode === undefined) continue;
		if (!last || mark.watchedAt > last.watchedAt || (mark.watchedAt === last.watchedAt && order(mark) > order(last))) last = mark;
	}
	if (!last) return null;
	const anchor = last;
	const row = heldEpisodes(show).find((held) => order(held) > order(anchor) && !seen.has(watchKey({ imdbId, season: held.season, episode: held.episode })));
	return row ? { imdbId, row, copy: pickCopy(row.copies, before), after: anchor.watchedAt } : null;
}

/** Finds the release and file path a playback key names (provider:hash-or-name:path) among the library's rows. */
export function releaseFinder(items: readonly LibraryItem[]): (key: string) => { item: LibraryItem; path: string } | undefined {
	const releases = new Map(items.map((item) => [`${item.provider}:${item.hash.toLowerCase() || item.filename}:`, item]));
	return (key) => {
		// A hashless release's name may hold colons: try each one.
		for (let at = key.indexOf(':'); at >= 0; at = key.indexOf(':', at + 1)) {
			const item = releases.get(key.slice(0, at + 1));
			if (item) return { item, path: key.slice(at + 1) };
		}
		return undefined;
	};
}

export interface Resume {
	key: string;
	entry: PlaybackEntry;
	item: LibraryItem;
	/** The file's path in its release, as playbackKey wrote it. */
	path: string;
}

/**
 * Continue Watching: files left part way, latest first, one per title, decided by the title's latest
 * playback. A file whose film or episode was finished or marked watched since (on any copy) is done,
 * and one whose release left the library cannot be resumed.
 */
export function continueWatching(entries: readonly [string, PlaybackEntry][], items: readonly LibraryItem[], watchedAt: (ref: WatchRef) => number | undefined): Resume[] {
	const find = releaseFinder(items);
	const titles = new Set<string>();
	const rows: Resume[] = [];
	for (const [key, entry] of [...entries].sort(([, a], [, b]) => b.updatedAt - a.updatedAt)) {
		const title = entry.imdbId ?? key;
		// A title's latest playback decides: an episode left part way before a later one was finished is not offered again.
		if (titles.has(title)) continue;
		titles.add(title);
		if (entry.finished || entry.position < MIN_RESUME_MS) continue;
		if (entry.imdbId) {
			const ref = entry.season !== undefined ? { imdbId: entry.imdbId, season: entry.season, episode: entry.episode } : entry.kind === 'tv' ? null : { imdbId: entry.imdbId };
			if (ref && (watchedAt(ref) ?? -1) >= entry.updatedAt) continue;
		}
		const found = find(key);
		if (found) rows.push({ key, entry, ...found });
	}
	return rows;
}
