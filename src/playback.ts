import { File, Paths } from 'expo-file-system';
import { filePath } from './core';
import type { LibraryFile, LibraryItem } from './model';
import type { CacheStore } from './titleIndex';

/**
 * Where each video was left, on this device only: the built-in player saves it every few
 * seconds and on exit, and offers to resume from it. Continue Watching and scrobbling read it.
 */
export interface PlaybackEntry {
	/** Milliseconds; 0 once finished. */
	position: number;
	/** Milliseconds, as the player measured it. */
	duration: number;
	/** Watched past FINISHED: the resume point is cleared, the entry stays as "watched". */
	finished: boolean;
	updatedAt: number;
	/** The file's name, for a list of what was played. */
	name: string;
	imdbId?: string;
	/** What the title is, so an episode DMM placed nowhere never counts as the show watched. */
	kind?: 'movie' | 'tv';
	season?: number;
	episode?: number;
	/** The last episode of a multi-episode file (1x06-07). */
	end?: number;
}

export type PlaybackMeta = Pick<PlaybackEntry, 'name' | 'imdbId' | 'kind' | 'season' | 'episode' | 'end'>;

export interface PlaybackEvent {
	key: string;
	entry: PlaybackEntry;
	/** True once, when this save crossed into finished. */
	ended: boolean;
}

/**
 * Watched from here on, here and on Trakt alike. Trakt marks a stop at 80% or more watched and refuses a
 * pause there (422 progress_too_high, live 2026-11-12: 79.9 paused, 80 refused), so 80% is the only line
 * at which a resume point and a watched mark never disagree between devices.
 */
export const FINISHED = 0.8;
/** Less than this in, there is nothing worth resuming. */
export const MIN_RESUME_MS = 30_000;
/** ponytail: the oldest entries go past this many; a bigger history needs an index rather than one JSON text. */
const MAX_ENTRIES = 1000;

/** The same file of the same release, on the same provider: its hash (or name, for a hashless release) and the file's path. */
export const playbackKey = (item: Pick<LibraryItem, 'provider' | 'hash' | 'filename'>, file: Pick<LibraryFile, 'name' | 'path'>): string =>
	`${item.provider}:${item.hash.toLowerCase() || item.filename}:${filePath(file.name, file.path)}`;

/** A JSON file the OS keeps (documents, not caches). */
export const documentStore = (name: string): CacheStore => ({
	read: async () => {
		const file = new File(Paths.document, name);
		return file.exists ? file.text() : null;
	},
	write: async (text) => {
		const file = new File(Paths.document, name);
		if (!file.exists) file.create();
		await file.write(text);
	},
});

export class PlaybackStore {
	private entries: Record<string, PlaybackEntry> = {};
	private loaded: Promise<void> | null = null;
	private readonly listeners = new Set<(event: PlaybackEvent) => void>();
	private readonly watchers = new Set<() => void>();
	/** Bumped on every change, for useSyncExternalStore. */
	version = 0;

	constructor(private readonly store: CacheStore = documentStore('playback-v1.json'), private readonly now: () => number = Date.now) {}

	load(): Promise<void> {
		this.loaded ??= this.store
			.read()
			.then((text) => {
				if (text) this.entries = JSON.parse(text) as Record<string, PlaybackEntry>;
			})
			// An unreadable file only forgets where videos were left.
			.catch(() => undefined)
			.then(() => this.changed());
		return this.loaded;
	}

	private changed(): void {
		this.version++;
		this.watchers.forEach((watcher) => watcher());
	}

	/** Every file played, by key. */
	list(): [string, PlaybackEntry][] {
		return Object.entries(this.entries);
	}

	/** Forgets where a file was left (Continue Watching's Remove). */
	async forget(key: string): Promise<void> {
		await this.load();
		delete this.entries[key];
		this.changed();
		await this.store.write(JSON.stringify(this.entries)).catch(() => undefined);
	}

	/** Any change, for screens (useSyncExternalStore). */
	watch = (watcher: () => void): (() => void) => {
		this.watchers.add(watcher);
		return () => this.watchers.delete(watcher);
	};

	getVersion = (): number => this.version;

	get(key: string): PlaybackEntry | undefined {
		return this.entries[key];
	}

	/** Where to offer resuming from, in milliseconds, or 0. */
	resumeAt(key: string): number {
		const entry = this.entries[key];
		return entry && !entry.finished && entry.position >= MIN_RESUME_MS ? entry.position : 0;
	}

	/** Records a position and saves; past FINISHED of the duration it marks the file watched and clears the resume point. */
	async record(key: string, position: number, duration: number, meta: PlaybackMeta): Promise<PlaybackEntry> {
		await this.load();
		const before = this.entries[key];
		const finished = duration > 0 && position >= duration * FINISHED;
		// Starting a watched file over and stopping early keeps it watched.
		const entry: PlaybackEntry = { ...meta, position: finished ? 0 : position, duration, finished: finished || Boolean(before?.finished && position < MIN_RESUME_MS), updatedAt: this.now() };
		this.entries[key] = entry;
		const keys = Object.keys(this.entries);
		if (keys.length > MAX_ENTRIES) {
			for (const old of keys.sort((a, b) => this.entries[a].updatedAt - this.entries[b].updatedAt).slice(0, keys.length - MAX_ENTRIES)) delete this.entries[old];
		}
		await this.store.write(JSON.stringify(this.entries)).catch(() => undefined);
		const event = { key, entry, ended: finished && !before?.finished };
		this.listeners.forEach((listener) => listener(event));
		this.changed();
		return entry;
	}

	/** Every save, for Continue Watching and scrobbling. */
	subscribe(listener: (event: PlaybackEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
}

export const playback = new PlaybackStore();
