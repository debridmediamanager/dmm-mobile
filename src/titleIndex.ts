import type { LibraryFile, LibraryItem, ProviderId } from './model';
import { ProviderApiError } from './providerApi';
import type { SyncIdentity } from './sync';
import { demoIdentification } from './demo';
import { askProbes, INFO_HASH, type FileProbe } from './mediaInfo';
import { askDmm, fetchTitleInfo, identifiable, identificationKey, LoginRefused, showEpisodes, type Identification, type Post, type ShowEpisodes, type TitleInfo } from './titles';

/** Where the index keeps itself between launches: one JSON text. */
export interface CacheStore {
	read(): Promise<string | null>;
	write(text: string): Promise<void>;
}

export interface TitleSource {
	/** The provider logins DMM may check before it names the library, in the order to try; none, and nothing is asked. */
	identities(): SyncIdentity[];
	detail(provider: ProviderId, itemId: string): Promise<LibraryItem>;
	/** A provider signed in with the demo key: its copies are archive.org files, not the torrents their hashes name. */
	isDemo?(provider: ProviderId): boolean;
}

interface Cached {
	/** identificationKey -> [asked at, answer or null] */
	answers: Record<string, [number, Identification | null]>;
	/** filesKey -> a finished release's files */
	files: Record<string, LibraryFile[]>;
	/** imdbId -> [fetched at, details] */
	info: Record<string, [number, TitleInfo]>;
	/** info hash -> [asked at, DMM's stored probes of its files, empty for none] */
	probes: Record<string, [number, FileProbe[]]>;
}

const VERSION = 1;
const DAY = 24 * 3600 * 1000;
/** DMM's identifier keeps learning: a release it could not name is asked again after a week. */
const MISS_TTL = 7 * DAY;
const INFO_TTL = 30 * DAY;
/** zurg probes a pack's files over several passes, so a release is asked again after a month, one with none after a week. */
const PROBE_TTL = 30 * DAY;
/** Real-Debrid's 250 requests a minute are shared with anything else on the account (zurg): one at a time, retried on 429. */
const RD_RETRY_MS = 5000;
const RD_RETRIES = 5;

const filesKey = (item: LibraryItem) => `${item.id}|${item.hash}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Names the library by title and remembers it on the device, so a refresh asks DMM only about
 * releases it has not seen, and a show's file lists are read from its provider once.
 * ponytail: entries for releases that left the library are kept; prune if the file grows past a few MB.
 */
export class TitleIndex {
	private cached: Cached = { answers: {}, files: {}, info: {}, probes: {} };
	private readonly probing = new Set<string>();
	private readonly listeners = new Set<() => void>();
	private loaded: Promise<void> | null = null;
	private running: Promise<void> | null = null;
	private again: readonly LibraryItem[] | null = null;
	private saveTimer: ReturnType<typeof setTimeout> | null = null;
	/** Bumped on every change, for useSyncExternalStore. */
	version = 0;
	/** "Naming titles 500/1,162…" while DMM is asked. */
	progress = '';
	error = '';

	constructor(
		private readonly source: TitleSource,
		private readonly store: CacheStore,
		private readonly post?: Post,
		private readonly wait: (ms: number) => Promise<unknown> = sleep,
		private readonly now: () => number = Date.now
	) {}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	getVersion = (): number => this.version;

	private changed(save = true): void {
		this.version++;
		this.listeners.forEach((listener) => listener());
		if (save) this.scheduleSave();
	}

	private scheduleSave(): void {
		if (this.saveTimer) return;
		this.saveTimer = setTimeout(() => {
			this.saveTimer = null;
			void this.store.write(JSON.stringify({ version: VERSION, ...this.cached })).catch(() => undefined);
		}, 1000);
	}

	load(): Promise<void> {
		this.loaded ??= this.store
			.read()
			.then((text) => {
				const parsed = text ? (JSON.parse(text) as Partial<Cached> & { version?: number }) : null;
				if (parsed?.version === VERSION) this.cached = { answers: parsed.answers ?? {}, files: parsed.files ?? {}, info: parsed.info ?? {}, probes: parsed.probes ?? {} };
			})
			// An unreadable cache is only a slower first load.
			.catch(() => undefined)
			.then(() => this.changed(false));
		return this.loaded;
	}

	/** The title a release is: undefined until DMM has been asked, null when it could not say. */
	identification(item: LibraryItem): Identification | null | undefined {
		const demo = demoIdentification(item.hash);
		if (demo) return demo;
		if (!identifiable(item)) return null;
		return this.cached.answers[identificationKey(item)]?.[1];
	}

	/** Asks DMM about every release not answered yet; a call during a run is taken up when it ends. */
	identify(items: readonly LibraryItem[]): Promise<void> {
		if (this.running) {
			this.again = items;
			return this.running;
		}
		this.running = this.run(items).finally(() => {
			this.running = null;
			const next = this.again;
			this.again = null;
			if (next) void this.identify(next);
		});
		return this.running;
	}

	private async run(items: readonly LibraryItem[]): Promise<void> {
		await this.load();
		const identities = this.source.identities();
		const now = this.now();
		const todo = items.filter((item) => {
			if (!identifiable(item) || demoIdentification(item.hash)) return false;
			const answer = this.cached.answers[identificationKey(item)];
			return !answer || (answer[1] === null && now - answer[0] > MISS_TTL);
		});
		if (identities.length === 0 || todo.length === 0) return;
		let done = 0;
		const total = new Set(todo.map(identificationKey)).size;
		this.progress = `Naming titles 0/${total.toLocaleString()}…`;
		this.error = '';
		this.changed(false);
		try {
			// A login DMM cannot verify (a provider holding a key used from a new address) makes way for the next.
			for (const identity of identities) {
				try {
					await askDmm(todo, identity, (answers) => {
						for (const [key, answer] of answers) this.cached.answers[key] = [this.now(), answer];
						done += answers.size;
						this.progress = `Naming titles ${Math.min(done, total).toLocaleString()}/${total.toLocaleString()}…`;
						this.changed();
					}, this.post, this.wait);
					break;
				} catch (error) {
					this.error = error instanceof Error ? error.message : 'DMM could not name the library.';
					if (!(error instanceof LoginRefused)) break;
				}
			}
		} finally {
			this.progress = '';
			this.changed(false);
		}
	}

	/** A release's files: from the list row when it has them, else from what was read before. */
	filesOf(item: LibraryItem): LibraryFile[] | undefined {
		if (item.filesLoaded && item.files.length > 0) return item.files;
		return this.cached.files[filesKey(item)];
	}

	/** Reads the file lists a show page needs from each provider, one Real-Debrid request at a time. */
	async loadFiles(items: readonly LibraryItem[], onProgress?: (done: number, total: number) => void): Promise<void> {
		await this.load();
		const todo = items.filter((item) => !this.filesOf(item));
		let done = 0;
		onProgress?.(done, todo.length);
		const read = async (item: LibraryItem) => {
			for (let attempt = 0; ; attempt++) {
				try {
					const detailed = await this.source.detail(item.provider, item.id);
					// Only a finished release keeps its files; one still downloading is read again next time
					// (until the next refresh the session holds its detailed row).
					if (detailed.status === 'finished') this.cached.files[filesKey(item)] = detailed.files;
					break;
				} catch (error) {
					if (!(error instanceof ProviderApiError && error.status === 429) || attempt >= RD_RETRIES) break;
					await this.wait(RD_RETRY_MS);
				}
			}
			onProgress?.(++done, todo.length);
			this.changed();
		};
		const rd = todo.filter((item) => item.provider === 'rd');
		const rest = todo.filter((item) => item.provider !== 'rd');
		await Promise.all([
			(async () => {
				for (const item of rd) await read(item);
			})(),
			Promise.all(rest.map(read)),
		]);
	}

	/** A show's episodes from the file lists read so far, placed with the episode counts once DMM gave them. */
	episodesOf(copies: readonly LibraryItem[], imdbId: string): ShowEpisodes {
		return showEpisodes(copies.map((item) => ({ item, files: this.filesOf(item) ?? [], seasons: this.identification(item)?.seasons })), this.cached.info[imdbId]?.[1].season_episode_counts);
	}

	/** What ffprobe knows of a release's files, from DMM: undefined until asked, empty when DMM stores none. */
	probesOf(item: Pick<LibraryItem, 'hash' | 'provider'>): FileProbe[] | undefined {
		return this.source.isDemo?.(item.provider) ? undefined : this.cached.probes[item.hash.toLowerCase()]?.[1];
	}

	/**
	 * Asks DMM for the stored probes of the releases a title page shows, only those not kept yet, never for the
	 * demo library's. A refused or rate-limited call leaves them unasked: the page asks again next time.
	 */
	async loadProbes(items: readonly LibraryItem[]): Promise<void> {
		await this.load();
		const now = this.now();
		const real = items.filter((item) => !this.source.isDemo?.(item.provider));
		const hashes = [...new Set(real.map((item) => item.hash.toLowerCase()))].filter((hash) => {
			if (!INFO_HASH.test(hash) || this.probing.has(hash)) return false;
			const kept = this.cached.probes[hash];
			return !kept || now - kept[0] > (kept[1].length ? PROBE_TTL : MISS_TTL);
		});
		const identities = this.source.identities();
		if (hashes.length === 0 || identities.length === 0) return;
		hashes.forEach((hash) => this.probing.add(hash));
		try {
			for (const identity of identities) {
				try {
					await askProbes(hashes, identity, (answers) => {
						for (const [hash, probes] of answers) this.cached.probes[hash] = [this.now(), probes];
						this.changed();
					}, this.post);
					break;
				} catch (error) {
					if (!(error instanceof LoginRefused)) break;
				}
			}
		} finally {
			hashes.forEach((hash) => this.probing.delete(hash));
		}
	}

	/** Plot, art and episode counts from DMM, kept for a month. */
	async info(imdbId: string, kind: 'movie' | 'tv'): Promise<TitleInfo> {
		await this.load();
		const cached = this.cached.info[imdbId];
		if (cached && this.now() - cached[0] < INFO_TTL) return cached[1];
		const info = await fetchTitleInfo(imdbId, kind);
		this.cached.info[imdbId] = [this.now(), info];
		this.changed();
		return info;
	}
}
