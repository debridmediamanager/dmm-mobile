import { traktEntries, type TrackerList } from './lists';
import type { ProviderId } from './model';
import { documentStore, FINISHED } from './playback';
import type { CacheStore } from './titleIndex';
import { TRAKT_API, TRAKT_CLIENT_ID } from './trakt';
import { watchKey, type RemotePlayback, type Tracker, type WatchedEntry, type WatchRef, type WatchStore } from './watched';

/**
 * A tracker (Trakt, Simkl) for the built-in player and the watched marks: scrobbling what plays, sending
 * marks made here (/sync/history), reading the watched history and resume points back (/sync/playback)
 * when its activity stamps say they moved. Whatever does not reach it is kept and sent later. Both speak
 * the same scrobble, history and playback shapes; what differs is in a TrackerApi (TRAKT here, SIMKL in
 * src/simkl.ts).
 */
export interface TraktReply {
	status: number;
	data: any;
	pageCount?: number;
	retryAfter?: number;
}
export type TraktHttp = (method: 'GET' | 'POST' | 'DELETE', path: string, token: string, body?: unknown) => Promise<TraktReply>;

export const traktHttp: TraktHttp = async (method, path, token, body) => {
	const res = await fetch(`${TRAKT_API}${path}`, {
		method,
		headers: { 'content-type': 'application/json', 'trakt-api-version': '2', 'trakt-api-key': TRAKT_CLIENT_ID, authorization: `Bearer ${token}` },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	const text = await res.text();
	let data: unknown = null;
	try {
		data = text ? JSON.parse(text) : null;
	} catch {
		// Trakt's errors may be empty or HTML (Cloudflare); the status says enough.
	}
	return { status: res.status, data, pageCount: Number(res.headers.get('x-pagination-page-count')) || undefined, retryAfter: Number(res.headers.get('retry-after')) || undefined };
};

/** Trakt and Simkl each take one write a second per user (Trakt AUTHED_API_POST_LIMIT, Simkl's rate-limit docs, 2026). */
const POST_GAP_MS = 1000;
const HISTORY_BATCH = 100;
/** A 429 asking for a longer wait (Simkl's daily allowance) pauses this tracker instead of holding the queue. */
const LONGEST_WAIT_MS = 60_000;
/** Trakt's largest page; it says how many there are (/sync/watched pages since 2026-06-30, DMM's Kodi addon). */
const PAGE = 250;

/** What the player knows about the file it plays. */
export interface ScrobbleMeta {
	imdbId?: string;
	kind?: 'movie' | 'tv';
	season?: number;
	episode?: number;
	provider?: ProviderId;
}
export type ScrobbleAction = 'start' | 'pause' | 'stop';

export const refOf = ({ imdbId, kind, season, episode }: ScrobbleMeta): WatchRef | null =>
	!imdbId ? null : kind === 'movie' ? { imdbId } : kind === 'tv' && season !== undefined && episode !== undefined ? { imdbId, season, episode } : null;

/** A film by its IMDb id, an episode by its show's IMDb id, season and number (Trakt finds the episode). */
export const itemOf = (ref: WatchRef) =>
	ref.season === undefined ? { movie: { ids: { imdb: ref.imdbId } } } : { show: { ids: { imdb: ref.imdbId } }, episode: { season: ref.season, number: ref.episode } };

/** /sync/history (with when each was watched) or /sync/history/remove (without). */
export function historyBody(entries: readonly WatchedEntry[], dated: boolean) {
	const when = (entry: WatchedEntry) => (dated ? { watched_at: new Date(entry.watchedAt).toISOString() } : {});
	const shows = new Map<string, Map<number, object[]>>();
	for (const entry of entries) {
		if (entry.season === undefined) continue;
		const seasons = shows.get(entry.imdbId) ?? shows.set(entry.imdbId, new Map()).get(entry.imdbId)!;
		seasons.set(entry.season, [...(seasons.get(entry.season) ?? []), { number: entry.episode, ...when(entry) }]);
	}
	return {
		movies: entries.filter((entry) => entry.season === undefined).map((entry) => ({ ids: { imdb: entry.imdbId }, ...when(entry) })),
		shows: [...shows].map(([imdb, seasons]) => ({ ids: { imdb }, seasons: [...seasons].map(([number, episodes]) => ({ number, episodes })) })),
	};
}

/** /sync/watched/movies and /sync/watched/shows?extended=progress as watched marks, by watchKey. Titles without an IMDb id are left out. */
export function watchedFromTrakt(movies: readonly any[], shows: readonly any[]): Map<string, WatchedEntry> {
	const found = new Map<string, WatchedEntry>();
	for (const row of movies) {
		const imdbId = row?.movie?.ids?.imdb;
		const watchedAt = Date.parse(row?.last_watched_at);
		if (imdbId && watchedAt) found.set(imdbId, { imdbId, watchedAt });
	}
	for (const row of shows) {
		const imdbId = row?.show?.ids?.imdb;
		if (!imdbId) continue;
		for (const season of row.seasons ?? []) {
			for (const episode of season?.episodes ?? []) {
				const ref = { imdbId, season: season.number, episode: episode.number };
				const watchedAt = Date.parse(episode.last_watched_at);
				if (Number.isInteger(ref.season) && Number.isInteger(ref.episode) && watchedAt) found.set(watchKey(ref), { ...ref, watchedAt });
			}
		}
	}
	return found;
}

/**
 * /sync/playback as resume points by watchKey, the newest per film or episode. Trakt's and Simkl's answers
 * share a shape; Simkl files anime under `anime` and numbers its episodes per cour, with the IMDb-style
 * season and number beside them (tvdb_season, tvdb_number; live 2026-11-12).
 */
export function playbackFromTrakt(items: readonly any[]): Record<string, RemotePlayback> {
	const found: Record<string, RemotePlayback> = {};
	for (const item of items) {
		const ref =
			item?.type === 'movie'
				? { imdbId: (item.movie ?? item.anime)?.ids?.imdb }
				: { imdbId: (item?.show ?? item?.anime)?.ids?.imdb, season: item?.episode?.tvdb_season ?? item?.episode?.season, episode: item?.episode?.tvdb_number ?? item?.episode?.number };
		const pausedAt = Date.parse(item?.paused_at);
		if (!ref.imdbId || !pausedAt || typeof item.progress !== 'number' || (item.type !== 'movie' && !Number.isInteger(ref.season))) continue;
		const key = watchKey(ref);
		if ((found[key]?.pausedAt ?? -1) < pausedAt) found[key] = { ...ref, progress: item.progress, pausedAt, id: Number(item.id) || 0 };
	}
	return found;
}

const retryable = (status: number) => status === 429 || status >= 500;

/** Reads a path once per sync (`paged`: all of Trakt's pages); a second read of the same path takes the first answer. */
export type TrackerGet = (path: string, paged?: boolean) => Promise<any>;

/** What the sync needs from a tracker's own API, beyond the shapes Trakt and Simkl share. */
export interface TrackerApi {
	id: Tracker;
	name: string;
	/** The activity stamps are read at most this often, unless forced (a pull to refresh, a new login). */
	checkEveryMs: number;
	/** Tell it where playback is after a seek while playing: Trakt ends "watching" at the runtime it expects; Simkl asks for no call. */
	startAfterSeek: boolean;
	refusals: Record<number, string>;
	activities: string;
	/** Tokens that change whenever the watched history or the resume points may have. */
	stamps(data: any): { watched: string; paused: string };
	/** The whole watched history, by watchKey. */
	history(get: TrackerGet): Promise<Map<string, WatchedEntry>>;
	/** Of a history batch it answered, which ones it holds now. */
	took(reply: TraktReply, batch: readonly WatchedEntry[]): (entry: WatchedEntry) => boolean;
	/**
	 * The user's lists: read the first time, when `stamp` moved, and, for lists that change without the user
	 * (Trakt's liked lists, kept by their owners), after `everyMs` or on a forced sync (pull to refresh).
	 */
	lists?: { stamp(data: any): string; everyMs?: number; read(get: TrackerGet, previous: readonly TrackerList[]): Promise<TrackerList[]> };
}

export const TRAKT: TrackerApi = {
	id: 'trakt',
	name: 'Trakt',
	checkEveryMs: 60_000,
	startAfterSeek: true,
	refusals: {
		403: 'Trakt refused DMM Mobile (403).',
		420: 'Trakt says your account is over a limit (420). Trakt VIP raises the limits.',
		423: 'Trakt locked your account (423); Trakt support can unlock it.',
		426: 'Trakt asks for VIP for this (426).',
	},
	activities: '/sync/last_activities',
	stamps: (data) => ({ watched: `${data?.movies?.watched_at}|${data?.episodes?.watched_at}`, paused: `${data?.movies?.paused_at}|${data?.episodes?.paused_at}` }),
	history: async (get) => watchedFromTrakt(await get('/sync/watched/movies', true), await get('/sync/watched/shows?extended=progress', true)),
	// Trakt counts what it took. When that is the whole batch, all of it is on Trakt now; otherwise the next import
	// tells which (not_found cannot: for a show it echoes every episode sent, found or not, live 2026-11-12).
	took: (reply, batch) => {
		const taken = ['added', 'updated'].reduce((sum, field) => sum + (Number(reply.data?.[field]?.movies) || 0) + (Number(reply.data?.[field]?.episodes) || 0), 0);
		return () => taken >= batch.length;
	},
	lists: {
		stamp: (data) => `${data?.watchlist?.updated_at}|${data?.lists?.updated_at}|${data?.lists?.liked_at}`,
		everyMs: 3600_000,
		read: async (get, previous) => {
			const lists: TrackerList[] = [{ id: 'watchlist', name: 'Watchlist', kind: 'watchlist', items: traktEntries(await get('/sync/watchlist/movies,shows/added/desc', true)) }];
			const own = ((await get('/users/me/lists', true)) as any[]).map((list) => ({ list, kind: 'own' as const }));
			const liked = ((await get('/users/me/likes/lists', true)) as any[]).map((row) => ({ list: row?.list, kind: 'liked' as const }));
			for (const { list, kind } of [...own, ...liked]) {
				const id = String(list?.ids?.trakt ?? '');
				if (!id) continue;
				const before = previous.find((other) => other.id === id);
				// Items are read again only when the list changed; one that cannot be read (deleted, made private) keeps what was read before.
				const items = before && before.updatedAt === list.updated_at ? before.items : await get(`/lists/${id}/items/movie,show`, true).then(traktEntries, () => before?.items);
				if (items) lists.push({ id, name: String(list.name ?? ''), kind, items, updatedAt: list.updated_at, ...(kind === 'liked' && list.user?.username ? { owner: String(list.user.username) } : {}) });
			}
			return lists;
		},
	},
};

/** The login a TrackerSync calls with: Trakt's (src/trakt.ts) or Simkl's (src/simkl.ts). */
export interface TrackerAccount {
	readonly login: unknown;
	/** Signed in, but the tracker lets the app read only: nothing is sent. */
	readonly readOnly?: boolean;
	token(stale?: boolean): Promise<string | null>;
	subscribe(listener: () => void): () => void;
}

interface SyncState {
	/** The last_activities stamps the watched history and resume points were last read at. */
	watched?: string;
	paused?: string;
	/** The first import joined this device's history with Trakt's. */
	joined?: boolean;
	playback: Record<string, RemotePlayback>;
	/** Pauses Trakt did not get (offline), the latest per film or episode, to send again. */
	unsent: Record<string, { ref: WatchRef; progress: number }>;
	/** Resume points removed here (Continue Watching's Remove) that Trakt still has. */
	drops: number[];
	/** The user's lists, the activity stamp and the time they were read at. */
	lists?: TrackerList[];
	listStamp?: string;
	listsAt?: number;
}

const empty = (): SyncState => ({ playback: {}, unsent: {}, drops: [] });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class TrackerSync<Account extends TrackerAccount = TrackerAccount> {
	private state = empty();
	private loaded: Promise<void> | null = null;
	private tail: Promise<unknown> = Promise.resolve();
	private lastPost = 0;
	private checkedAt = 0;
	private timer: ReturnType<typeof setTimeout> | null = null;
	/** Until then the tracker refused more calls (its daily allowance). */
	private restUntil = 0;
	private readonly listeners = new Set<() => void>();
	/** Bumped on every change, for useSyncExternalStore. */
	version = 0;
	/** What the tracker last refused, for Settings; cleared by a sync that works. */
	error = '';

	constructor(
		readonly account: Account,
		private readonly marks: WatchStore,
		/** The demo library never reaches a tracker. */
		private readonly isDemo: (provider: ProviderId) => boolean = () => false,
		private readonly store: CacheStore = documentStore('trakt-v1.json'),
		private readonly http: TraktHttp = traktHttp,
		private readonly now: () => number = Date.now,
		private readonly wait: (ms: number) => Promise<unknown> = sleep,
		readonly api: TrackerApi = TRAKT
	) {
		let connected = false;
		account.subscribe(() => {
			// A login read, adopted at a sign-in or linked: read the tracker now, not at the next start.
			if (account.login && !connected) void this.sync(true);
			// Disconnected: what was read from that account goes, the watched marks stay.
			if (!account.login && this.state.joined) void this.run(async () => this.reset());
			connected = Boolean(account.login);
		});
		marks.subscribe(() => void (marks.pending(api.id).length && this.soon()));
	}

	load(): Promise<void> {
		this.loaded ??= this.store
			.read()
			.then((text) => {
				if (text) this.state = { ...empty(), ...(JSON.parse(text) as SyncState) };
			})
			.catch(() => undefined)
			.then(() => this.changed());
		return this.loaded;
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	getVersion = (): number => this.version;

	private changed(): void {
		this.version++;
		this.listeners.forEach((listener) => listener());
	}

	private async persist(): Promise<void> {
		this.changed();
		await this.store.write(JSON.stringify(this.state)).catch(() => undefined);
	}

	private async reset(): Promise<void> {
		this.state = empty();
		this.checkedAt = 0;
		this.error = '';
		await this.persist();
	}

	/** The tracker's resume points, any device's; none while no account is connected. */
	playback(): RemotePlayback[] {
		return this.account.login ? Object.values(this.state.playback) : [];
	}

	/** The tracker's lists (src/lists.ts); none while no account is connected. */
	lists(): TrackerList[] {
		return this.account.login ? (this.state.lists ?? []) : [];
	}

	/** One GET as the user (Trakt's calendar), queued with the rest; undefined when it fails or nobody is connected. */
	read(path: string): Promise<any> {
		return this.account.login ? this.run(() => this.get(path)) : Promise.resolve(undefined);
	}

	resumeFor(ref: WatchRef): RemotePlayback | undefined {
		return this.account.login ? this.state.playback[watchKey(ref)] : undefined;
	}

	/** Resolves once everything queued so far is done. */
	settled(): Promise<void> {
		return this.tail.then(() => undefined);
	}

	/** One job at a time: a tracker takes a write a second, and an import must not interleave with sends. */
	private run<T>(job: () => Promise<T>): Promise<T | undefined> {
		const next = this.tail.then(async () => {
			await this.load();
			return job();
		}).catch(() => undefined);
		this.tail = next;
		return next;
	}

	/** One call as the user: a refused token is renewed once, 429 waits as the tracker asks. Throws when offline or signed out. */
	private async call(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<TraktReply> {
		let stale = false;
		for (let attempt = 0; attempt < 4; attempt++) {
			if (this.now() < this.restUntil) throw new Error(this.error);
			const token = await this.account.token(stale);
			if (!token) throw new Error(`${this.api.name} is not connected.`);
			if (method !== 'GET') {
				const gap = this.lastPost + POST_GAP_MS - this.now();
				if (gap > 0) await this.wait(gap);
				this.lastPost = this.now();
			}
			const reply = await this.http(method, path, token, body);
			if (reply.status === 401 && !stale) stale = true;
			else if (reply.status === 429) {
				const ms = (reply.retryAfter ?? 2 ** attempt) * 1000;
				if (ms > LONGEST_WAIT_MS) {
					this.restUntil = this.now() + ms;
					this.error = `${this.api.name} allows no more requests today; DMM Mobile sends what is waiting once it does.`;
					throw new Error(this.error);
				}
				await this.wait(ms);
			} else return reply;
		}
		throw new Error(`${this.api.name} is busy.`);
	}

	private refusedWith(reply: TraktReply): void {
		const { name, refusals } = this.api;
		this.error = refusals[reply.status] ?? (reply.status === 401 ? `${name} signed DMM Mobile out: connect again.` : `${name} answered ${reply.status}.`);
	}

	/**
	 * What the player reports: start (playing, after a pause, or `again` after a seek), pause, stop (leaving
	 * or the end). The trackers and the app share one line, FINISHED (80%): before it a stop goes as a pause
	 * (a resume point), from it a pause goes as a stop (Trakt refuses pauses there, both mark a stop watched).
	 * Unsent pauses are kept; an unsent finish waits as a watched mark (/sync/history, with its time).
	 */
	scrobble(meta: ScrobbleMeta, action: ScrobbleAction, progress: number, again = false): void {
		const ref = refOf(meta);
		if (!ref || !this.account.login || this.account.readOnly || (meta.provider && this.isDemo(meta.provider))) return;
		if (again && !this.api.startAfterSeek) return;
		const call = action === 'start' ? 'start' : progress < FINISHED * 100 ? 'pause' : 'stop';
		const key = watchKey(ref);
		const percent = Math.round(Math.min(100, Math.max(0, progress)) * 100) / 100;
		void this.run(async () => {
			let reply: TraktReply | null = null;
			try {
				reply = await this.call('POST', `/scrobble/${call}`, { ...itemOf(ref), progress: percent });
			} catch {
				// Offline: kept below.
			}
			// 409: this item was just scrobbled; Trakt has it.
			const sent = reply?.status === 201 || reply?.status === 409;
			if (call === 'pause') {
				if (sent) {
					this.state.playback[key] = { ...ref, progress: percent, pausedAt: this.now(), id: Number(reply!.data?.id) || 0 };
					delete this.state.unsent[key];
				} else if (!reply || retryable(reply.status)) this.state.unsent[key] = { ref, progress: percent };
			} else if (sent) {
				// The tracker drops the resume point on start and stop.
				delete this.state.playback[key];
				delete this.state.unsent[key];
				if (call === 'stop') await this.marks.settle([ref], this.api.id, true);
			}
			if (reply && !sent && !retryable(reply.status) && reply.status !== 404 && reply.status !== 422) this.refusedWith(reply);
			await this.persist();
		});
	}

	/** Continue Watching's Remove: the tracker's resume point goes here at once and from the tracker with the next send. */
	forget(ref: WatchRef): void {
		const key = watchKey(ref);
		const item = this.state.playback[key];
		delete this.state.unsent[key];
		if (!item) return;
		delete this.state.playback[key];
		if (item.id) this.state.drops.push(item.id);
		void this.persist();
		void this.run(() => this.flush());
	}

	/** Marks come in bursts (a whole season): sent a moment after the last. */
	private soon(): void {
		if (!this.account.login || this.account.readOnly) return;
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.timer = null;
			void this.run(() => this.flush());
		}, 3000);
	}

	/**
	 * Sends what the tracker missed: marks and removals made here, pauses made offline, resume points removed
	 * here. Marks wait for the first import, which decides what of this device's history the tracker lacks.
	 */
	private async flush(): Promise<void> {
		if (this.account.readOnly) return;
		try {
			const pending = this.state.joined ? this.marks.pending(this.api.id) : [];
			for (const removal of [false, true]) {
				const changes = pending.filter((entry) => Boolean(entry.removed) === removal);
				for (let at = 0; at < changes.length; at += HISTORY_BATCH) {
					const batch = changes.slice(at, at + HISTORY_BATCH);
					const reply = await this.call('POST', removal ? '/sync/history/remove' : '/sync/history', historyBody(batch, !removal));
					if (reply.status !== 200 && reply.status !== 201) return this.refusedWith(reply);
					const took = this.api.took(reply, batch);
					await this.marks.settle(batch.filter(took), this.api.id, !removal);
					await this.marks.settle(batch.filter((entry) => !took(entry)), this.api.id);
				}
			}
			for (const [key, { ref, progress }] of Object.entries(this.state.unsent)) {
				const reply = await this.call('POST', '/scrobble/pause', { ...itemOf(ref), progress });
				if (retryable(reply.status)) return;
				delete this.state.unsent[key];
				if (reply.status === 201) this.state.playback[key] = { ...ref, progress, pausedAt: this.now(), id: Number(reply.data?.id) || 0 };
			}
			for (const id of [...this.state.drops]) {
				const reply = await this.call('DELETE', `/sync/playback/${id}`);
				if (retryable(reply.status)) return;
				this.state.drops = this.state.drops.filter((other) => other !== id);
			}
		} finally {
			await this.persist();
		}
	}

	/**
	 * Sends what the tracker missed, then reads the watched history, resume points and lists again when its
	 * activity stamps say they changed. At most once per checkEveryMs unless `force`.
	 */
	sync(force = false): Promise<void> {
		if (!this.account.login || (!force && this.now() - this.checkedAt < this.api.checkEveryMs)) return Promise.resolve();
		this.checkedAt = this.now();
		return this.run(async () => {
			await this.flush();
			const activity = await this.call('GET', this.api.activities);
			if (activity.status !== 200) return this.refusedWith(activity);
			const { watched, paused } = this.api.stamps(activity.data ?? {});
			// Simkl's lists come in its history's answer: one request for both.
			const answers = new Map<string, Promise<any>>();
			const read: TrackerGet = (path, paged) => {
				if (!answers.has(path)) answers.set(path, paged ? this.pages(path) : this.get(path));
				return answers.get(path)!;
			};
			try {
				if (!this.state.joined || watched !== this.state.watched) {
					const first = !this.state.joined;
					await this.marks.merge(await this.api.history(read), this.api.id, first);
					Object.assign(this.state, { joined: true, watched });
					// What only this device had goes to the tracker now.
					if (first) await this.flush();
				}
				if (paused !== this.state.paused) {
					const reply = await this.call('GET', '/sync/playback');
					if (reply.status !== 200 || !Array.isArray(reply.data)) return this.refusedWith(reply);
					Object.assign(this.state, { playback: playbackFromTrakt(reply.data), paused });
				}
				const lists = this.api.lists;
				const stamp = lists?.stamp(activity.data ?? {});
				const due = lists && (!this.state.lists || stamp !== this.state.listStamp || (lists.everyMs !== undefined && (force || this.now() - (this.state.listsAt ?? 0) >= lists.everyMs)));
				if (due) Object.assign(this.state, { lists: await lists.read(read, this.state.lists ?? []), listStamp: stamp, listsAt: this.now() });
				this.error = '';
			} finally {
				await this.persist();
			}
		}).then(() => undefined);
	}

	private async get(path: string): Promise<any> {
		const reply = await this.call('GET', path);
		if (reply.status !== 200) {
			this.refusedWith(reply);
			throw new Error(this.error);
		}
		return reply.data;
	}

	private async pages(path: string): Promise<any[]> {
		const rows: any[] = [];
		// ponytail: stops at 200 pages (50,000 films or shows), far past any history seen.
		for (let page = 1; page <= 200; page++) {
			const reply = await this.call('GET', `${path}${path.includes('?') ? '&' : '?'}page=${page}&limit=${PAGE}`);
			if (reply.status !== 200 || !Array.isArray(reply.data)) {
				this.refusedWith(reply);
				throw new Error(this.error);
			}
			rows.push(...reply.data);
			if (!reply.data.length || page >= (reply.pageCount ?? page)) break;
		}
		return rows;
	}
}
