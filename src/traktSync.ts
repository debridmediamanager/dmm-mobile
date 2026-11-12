import type { ProviderId } from './model';
import { documentStore, FINISHED } from './playback';
import type { CacheStore } from './titleIndex';
import { TRAKT_API, TRAKT_CLIENT_ID, type TraktAccount } from './trakt';
import { watchKey, type RemotePlayback, type WatchedEntry, type WatchRef, type WatchStore } from './watched';

/**
 * Trakt for the built-in player and the watched marks: scrobbling what plays, sending marks made here
 * (/sync/history), reading the watched history and resume points back (/sync/watched, /sync/playback)
 * when /sync/last_activities says they moved. Whatever does not reach Trakt is kept and sent later.
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

/** Trakt takes one write a second per user (AUTHED_API_POST_LIMIT, 2026-10 docs). */
const POST_GAP_MS = 1000;
/** last_activities is read at most this often (app start and coming back to the app). */
const CHECK_EVERY_MS = 60_000;
const HISTORY_BATCH = 100;
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

/** /sync/playback as resume points by watchKey, the newest per film or episode. */
export function playbackFromTrakt(items: readonly any[]): Record<string, RemotePlayback> {
	const found: Record<string, RemotePlayback> = {};
	for (const item of items) {
		const ref = item?.type === 'movie' ? { imdbId: item.movie?.ids?.imdb } : { imdbId: item?.show?.ids?.imdb, season: item?.episode?.season, episode: item?.episode?.number };
		const pausedAt = Date.parse(item?.paused_at);
		if (!ref.imdbId || !pausedAt || typeof item.progress !== 'number' || (item.type !== 'movie' && !Number.isInteger(ref.season))) continue;
		const key = watchKey(ref);
		if ((found[key]?.pausedAt ?? -1) < pausedAt) found[key] = { ...ref, progress: item.progress, pausedAt, id: Number(item.id) || 0 };
	}
	return found;
}

const retryable = (status: number) => status === 429 || status >= 500;

const REFUSALS: Record<number, string> = {
	403: 'Trakt refused DMM Mobile (403).',
	420: 'Trakt says your account is over a limit (420). Trakt VIP raises the limits.',
	423: 'Trakt locked your account (423); Trakt support can unlock it.',
	426: 'Trakt asks for VIP for this (426).',
};

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
}

const empty = (): SyncState => ({ playback: {}, unsent: {}, drops: [] });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class TraktSync {
	private state = empty();
	private loaded: Promise<void> | null = null;
	private tail: Promise<unknown> = Promise.resolve();
	private lastPost = 0;
	private checkedAt = 0;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private readonly listeners = new Set<() => void>();
	/** Bumped on every change, for useSyncExternalStore. */
	version = 0;
	/** What Trakt last refused, for Settings; cleared by a sync that works. */
	error = '';

	constructor(
		readonly account: TraktAccount,
		private readonly marks: WatchStore,
		/** The demo library never reaches Trakt. */
		private readonly isDemo: (provider: ProviderId) => boolean = () => false,
		private readonly store: CacheStore = documentStore('trakt-v1.json'),
		private readonly http: TraktHttp = traktHttp,
		private readonly now: () => number = Date.now,
		private readonly wait: (ms: number) => Promise<unknown> = sleep
	) {
		let connected = false;
		account.subscribe(() => {
			// A login read, adopted at a sign-in or linked: read Trakt now, not at the next start.
			if (account.login && !connected) void this.sync(true);
			// Disconnected: what was read from that account goes, the watched marks stay.
			if (!account.login && this.state.joined) void this.run(async () => this.reset());
			connected = Boolean(account.login);
		});
		marks.subscribe(() => void (marks.pending().length && this.soon()));
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

	/** Trakt's resume points, any device's; none while no account is connected. */
	playback(): RemotePlayback[] {
		return this.account.login ? Object.values(this.state.playback) : [];
	}

	resumeFor(ref: WatchRef): RemotePlayback | undefined {
		return this.account.login ? this.state.playback[watchKey(ref)] : undefined;
	}

	/** Resolves once everything queued so far is done. */
	settled(): Promise<void> {
		return this.tail.then(() => undefined);
	}

	/** One job at a time: Trakt takes a write a second, and an import must not interleave with sends. */
	private run<T>(job: () => Promise<T>): Promise<T | undefined> {
		const next = this.tail.then(async () => {
			await this.load();
			return job();
		}).catch(() => undefined);
		this.tail = next;
		return next;
	}

	/** One call as the user: a refused token is renewed once, 429 waits as Trakt asks. Throws when offline or signed out. */
	private async call(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<TraktReply> {
		let stale = false;
		for (let attempt = 0; attempt < 4; attempt++) {
			const token = await this.account.token(stale);
			if (!token) throw new Error('Trakt is not connected.');
			if (method !== 'GET') {
				const gap = this.lastPost + POST_GAP_MS - this.now();
				if (gap > 0) await this.wait(gap);
				this.lastPost = this.now();
			}
			const reply = await this.http(method, path, token, body);
			if (reply.status === 401 && !stale) stale = true;
			else if (reply.status === 429) await this.wait((reply.retryAfter ?? 2 ** attempt) * 1000);
			else return reply;
		}
		throw new Error('Trakt is busy.');
	}

	private refusedWith(reply: TraktReply): void {
		this.error = REFUSALS[reply.status] ?? (reply.status === 401 ? 'Trakt signed DMM Mobile out: connect again.' : `Trakt answered ${reply.status}.`);
	}

	/**
	 * What the player reports: start (playing, after a pause or a seek), pause, stop (leaving or the end).
	 * Trakt and the app share one line, FINISHED (80%): before it a stop goes as a pause (a resume point),
	 * from it a pause goes as a stop (Trakt refuses pauses there and marks a stop watched). Unsent pauses
	 * are kept; an unsent finish waits as a watched mark (/sync/history, with its time).
	 */
	scrobble(meta: ScrobbleMeta, action: ScrobbleAction, progress: number): void {
		const ref = refOf(meta);
		if (!ref || !this.account.login || (meta.provider && this.isDemo(meta.provider))) return;
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
				// Trakt drops the resume point on start and stop.
				delete this.state.playback[key];
				delete this.state.unsent[key];
				if (call === 'stop') await this.marks.settle([ref], true);
			}
			if (reply && !sent && !retryable(reply.status) && reply.status !== 404 && reply.status !== 422) this.refusedWith(reply);
			await this.persist();
		});
	}

	/** Continue Watching's Remove: Trakt's resume point goes here at once and from Trakt with the next send. */
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
		if (!this.account.login) return;
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.timer = null;
			void this.run(() => this.flush());
		}, 3000);
	}

	/**
	 * Sends what Trakt missed: marks and removals made here, pauses made offline, resume points removed here.
	 * Marks wait for the first import, which decides what of this device's history Trakt lacks.
	 */
	private async flush(): Promise<void> {
		try {
			const pending = this.state.joined ? this.marks.pending() : [];
			for (const removal of [false, true]) {
				const changes = pending.filter((entry) => Boolean(entry.removed) === removal);
				for (let at = 0; at < changes.length; at += HISTORY_BATCH) {
					const batch = changes.slice(at, at + HISTORY_BATCH);
					const reply = await this.call('POST', removal ? '/sync/history/remove' : '/sync/history', historyBody(batch, !removal));
					if (reply.status !== 200 && reply.status !== 201) return this.refusedWith(reply);
					// Trakt counts what it took. When that is the whole batch, all of it is on Trakt now; otherwise the next
					// import tells which (not_found cannot: for a show it echoes every episode sent, found or not, live 2026-11-12).
					const taken = ['added', 'updated'].reduce((sum, field) => sum + (Number(reply.data?.[field]?.movies) || 0) + (Number(reply.data?.[field]?.episodes) || 0), 0);
					await this.marks.settle(batch, !removal && taken >= batch.length);
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
	 * Sends what Trakt missed, then reads the watched history and resume points again when
	 * last_activities says they changed. At most once a minute unless `force`.
	 */
	sync(force = false): Promise<void> {
		if (!this.account.login || (!force && this.now() - this.checkedAt < CHECK_EVERY_MS)) return Promise.resolve();
		this.checkedAt = this.now();
		return this.run(async () => {
			await this.flush();
			const activity = await this.call('GET', '/sync/last_activities');
			if (activity.status !== 200) return this.refusedWith(activity);
			const stamps = activity.data ?? {};
			const watched = `${stamps.movies?.watched_at}|${stamps.episodes?.watched_at}`;
			const paused = `${stamps.movies?.paused_at}|${stamps.episodes?.paused_at}`;
			try {
				if (!this.state.joined || watched !== this.state.watched) {
					const movies = await this.pages('/sync/watched/movies');
					const shows = await this.pages('/sync/watched/shows?extended=progress');
					const first = !this.state.joined;
					await this.marks.merge(watchedFromTrakt(movies, shows), first);
					Object.assign(this.state, { joined: true, watched });
					// What only this device had goes to Trakt now.
					if (first) await this.flush();
				}
				if (paused !== this.state.paused) {
					const reply = await this.call('GET', '/sync/playback');
					if (reply.status !== 200 || !Array.isArray(reply.data)) return this.refusedWith(reply);
					Object.assign(this.state, { playback: playbackFromTrakt(reply.data), paused });
				}
				this.error = '';
			} finally {
				await this.persist();
			}
		}).then(() => undefined);
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
