import type { TrackerList } from './lists';
import { documentStore } from './playback';
import type { CacheStore } from './titleIndex';
import { episodeCode, type EpisodeCopy, type ShowEpisodes } from './titles';
import { TRAKT_API, TRAKT_CLIENT_ID } from './trakt';
import { DMM_ORIGIN } from './tvLink';
import type { Tracker } from './watched';

/**
 * The calendar of your shows: episodes from the last 7 days and the next 30, grouped by day where the
 * device is. Your shows are the library's shows and the ones Simkl lists as watching or plan to watch;
 * with Trakt connected, Trakt's own calendar of the user's shows (watched, watchlist, collection) too.
 *
 * Sources (live 2026-11-12): Trakt's /calendars/my/shows for a Trakt user, one request. For every other
 * show DMM's /api/info/show, whose answer holds only the last and the next episode; a show with either
 * inside the window then gets those seasons' episodes from Trakt's public season list (no login), which
 * has every air time. Simkl's public calendar is a 2.7 MB file whose anime carry no IMDb ids, so it is not read.
 */
export interface CalendarEpisode {
	/** The show's. */
	imdbId: string;
	show: string;
	season: number;
	episode: number;
	title?: string;
	/** When it airs (ms); the day's local midnight when only the date is known. */
	airsAt: number;
	/** False when only the date is known. */
	timed: boolean;
}

export interface CalendarShow {
	imdbId: string;
	title: string;
}

export const PAST_DAYS = 7;
export const NEXT_DAYS = 30;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Local midnight `days` after `at`'s day: calendar arithmetic, so a daylight saving change never shifts it by an hour. */
export const dayStart = (at: number, days = 0): number => {
	const date = new Date(at);
	return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days).getTime();
};

/** "2026-11-13T07:00:00.000Z", or a bare "2026-11-13": that day here, time unknown. */
export function airTime(value: unknown): Pick<CalendarEpisode, 'airsAt' | 'timed'> | null {
	if (typeof value !== 'string') return null;
	const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (date) return { airsAt: new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3])).getTime(), timed: false };
	const at = Date.parse(value);
	return Number.isNaN(at) ? null : { airsAt: at, timed: true };
}

const episodeOf = (imdbId: unknown, show: unknown, season: unknown, episode: unknown, title: unknown, aired: unknown): CalendarEpisode[] => {
	const when = airTime(aired);
	if (typeof imdbId !== 'string' || !/^tt\d+$/.test(imdbId) || !Number.isInteger(season) || !Number.isInteger(episode) || !when) return [];
	return [{ imdbId, show: typeof show === 'string' && show ? show : imdbId, season: season as number, episode: episode as number, ...(typeof title === 'string' && title ? { title } : {}), ...when }];
};

/** Trakt's /calendars/my/shows rows. */
export const fromTraktCalendar = (rows: readonly any[]): CalendarEpisode[] =>
	rows.flatMap((row) => episodeOf(row?.show?.ids?.imdb, row?.show?.title, row?.episode?.season, row?.episode?.number, row?.episode?.title, row?.first_aired));

/** Trakt's /shows/{id}/seasons/{n}?extended=full: every episode of a season with its air time. */
export const fromTraktSeason = (show: CalendarShow, rows: readonly any[]): CalendarEpisode[] =>
	rows.flatMap((row) => episodeOf(show.imdbId, show.title, row?.season, row?.number, row?.title, row?.first_aired));

/** DMM's /api/info/show: its last and next episode. */
export const fromShowInfo = (show: CalendarShow, info: any): CalendarEpisode[] =>
	[info?.last_episode_to_air, info?.next_episode_to_air].flatMap((ep) => episodeOf(show.imdbId, show.title, ep?.season_number, ep?.episode_number, ep?.name, ep?.first_aired));

const keyOf = (ep: Pick<CalendarEpisode, 'imdbId' | 'season' | 'episode'>) => `${ep.imdbId}:${ep.season}:${ep.episode}`;

/** Every source's episodes inside the window (7 days back to 30 ahead, whole local days), each once by show and number, in air order. */
export function calendarOf(sources: readonly (readonly CalendarEpisode[])[], now: number): CalendarEpisode[] {
	const from = dayStart(now, -PAST_DAYS);
	const to = dayStart(now, NEXT_DAYS + 1);
	const found = new Map<string, CalendarEpisode>();
	for (const ep of sources.flat()) {
		if (ep.airsAt < from || ep.airsAt >= to) continue;
		const had = found.get(keyOf(ep));
		// An exact time beats a bare date for the same episode.
		if (!had || (!had.timed && ep.timed)) found.set(keyOf(ep), ep);
	}
	return [...found.values()].sort((a, b) => a.airsAt - b.airsAt || a.show.localeCompare(b.show) || a.season - b.season || a.episode - b.episode);
}

/** The calendar by local day, each day's episodes in air order. */
export function byDay(episodes: readonly CalendarEpisode[]): { day: number; episodes: CalendarEpisode[] }[] {
	const days = new Map<number, CalendarEpisode[]>();
	for (const ep of episodes) {
		const day = dayStart(ep.airsAt);
		days.set(day, [...(days.get(day) ?? []), ep]);
	}
	return [...days].sort(([a], [b]) => a - b).map(([day, list]) => ({ day, episodes: list }));
}

/** "Today", "Tomorrow", "Yesterday", else "Friday, Nov 13" in the device's language. */
export function dayLabel(day: number, now: number): string {
	const near: Record<number, string> = { [dayStart(now, -1)]: 'Yesterday', [dayStart(now)]: 'Today', [dayStart(now, 1)]: 'Tomorrow' };
	return near[day] ?? new Date(day).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

export const timeLabel = (ep: CalendarEpisode): string => (ep.timed ? new Date(ep.airsAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '');

/** The library's copies of an episode, a file holding two (S01E06-E07) included. */
export function heldCopies(show: ShowEpisodes, season: number, episode: number): EpisodeCopy[] {
	return [...(show.seasons.get(season) ?? [])].flatMap(([first, copies]) => copies.filter((copy) => first === episode || (first < episode && (copy.ref?.end ?? first) >= episode)));
}

/** Your shows: the library's, and Simkl's watching and plan to watch (Trakt's calendar already covers Trakt's). */
export function yourShows(library: Iterable<{ imdbId: string; title: string; kind: 'movie' | 'tv' }>, trackers: readonly { tracker: { api: { id: Tracker } }; lists: readonly TrackerList[] }[]): CalendarShow[] {
	const shows = new Map<string, CalendarShow>();
	for (const title of library) if (title.kind === 'tv') shows.set(title.imdbId, { imdbId: title.imdbId, title: title.title });
	for (const { tracker, lists } of trackers) {
		if (tracker.api.id !== 'simkl') continue;
		for (const list of lists) {
			if (list.id !== 'watching' && list.id !== 'plantowatch') continue;
			for (const entry of list.items) if (entry.kind === 'tv' && !shows.has(entry.imdbId)) shows.set(entry.imdbId, { imdbId: entry.imdbId, title: entry.title });
		}
	}
	return [...shows.values()];
}

/** A local notification for an episode: when it airs, or 9:00 that day when only the date is known. */
export interface Alert {
	id: string;
	at: number;
	title: string;
	body: string;
}
/** iOS keeps 64 pending notifications per app; the furthest wait for a later refresh. */
export const ALERT_LIMIT = 60;
const DATE_ONLY_ALERT_HOUR = 9;

export function alertsFor(episodes: readonly CalendarEpisode[], now: number): Alert[] {
	return episodes
		.map((ep) => ({
			id: `episode:${keyOf(ep)}`,
			at: ep.timed ? ep.airsAt : ep.airsAt + DATE_ONLY_ALERT_HOUR * HOUR,
			title: ep.show,
			body: `${episodeCode(ep.season, ep.episode)}${ep.title ? ` "${ep.title}"` : ''} ${ep.timed ? 'is out now' : 'comes out today'}`,
		}))
		.filter((alert) => alert.at > now)
		.sort((a, b) => a.at - b.at)
		.slice(0, ALERT_LIMIT);
}

/** What to cancel and what to schedule so the scheduled alerts become `wanted`; an unchanged one is left alone. */
export function alertDiff(scheduled: readonly Alert[], wanted: readonly Alert[]): { cancel: string[]; add: Alert[] } {
	const same = (a: Alert, b: Alert) => a.at === b.at && a.title === b.title && a.body === b.body;
	const want = new Map(wanted.map((alert) => [alert.id, alert]));
	const have = new Map(scheduled.map((alert) => [alert.id, alert]));
	return {
		cancel: scheduled.filter((alert) => !want.has(alert.id) || !same(alert, want.get(alert.id)!)).map((alert) => alert.id),
		add: wanted.filter((alert) => !have.has(alert.id) || !same(alert, have.get(alert.id)!)),
	};
}

export type GetJson = (url: string, headers?: Record<string, string>) => Promise<any>;
const getJson: GetJson = async (url, headers) => {
	const res = await fetch(url, { headers });
	if (!res.ok) throw new Error(`${res.status}`);
	return res.json();
};
const TRAKT_PUBLIC = { 'trakt-api-version': '2', 'trakt-api-key': TRAKT_CLIENT_ID };

/** Reads one path as the Trakt user; undefined when it could not (TrackerSync.read). */
export interface TraktReader {
	read(path: string): Promise<any>;
}

interface ShowEntry {
	/** Read at, and due to be read again at. */
	at: number;
	due: number;
	episodes: CalendarEpisode[];
}
interface State {
	trakt?: { at: number; episodes: CalendarEpisode[] };
	shows: Record<string, ShowEntry>;
}

/** Trakt's calendar is read again after this, or on pull to refresh (not more than once a minute). */
const TRAKT_EVERY = 6 * HOUR;
const FORCED_EVERY = MIN;
/** A show airing now is checked twice a day, one between seasons weekly, an ended one monthly; a failed read in an hour. */
const ACTIVE_EVERY = 12 * HOUR;
const IDLE_EVERY = 7 * DAY;
const ENDED_EVERY = 30 * DAY;
const RETRY_EVERY = HOUR;
const PARALLEL = 4;

/** The calendar's answers, kept on the device between launches (src/calendar.ts). */
export class CalendarStore {
	private state: State = { shows: {} };
	private loaded: Promise<void> | null = null;
	private running: Promise<void> | null = null;
	private again: (() => Promise<void>) | null = null;
	private readonly listeners = new Set<() => void>();
	version = 0;
	/** "Checking your shows 4/120…" while it reads. */
	progress = '';
	error = '';

	constructor(
		private readonly store: CacheStore = documentStore('calendar-v1.json'),
		private readonly get: GetJson = getJson,
		private readonly now: () => number = Date.now
	) {}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	getVersion = (): number => this.version;

	private changed(): void {
		this.version++;
		this.listeners.forEach((listener) => listener());
	}

	load(): Promise<void> {
		this.loaded ??= this.store
			.read()
			.then((text) => {
				const saved = text ? (JSON.parse(text) as Partial<State>) : null;
				if (saved) this.state = { ...saved, shows: saved.shows ?? {} };
			})
			.catch(() => undefined)
			.then(() => this.changed());
		return this.loaded;
	}

	/** Your shows' episodes in the window; Trakt's calendar only while Trakt is connected. Trakt's answer decides for the shows it lists. */
	episodes(shows: readonly CalendarShow[], withTrakt: boolean): CalendarEpisode[] {
		const trakt = withTrakt ? (this.state.trakt?.episodes ?? []) : [];
		const covered = new Set(trakt.map((ep) => ep.imdbId));
		return calendarOf([trakt, ...shows.filter((show) => !covered.has(show.imdbId)).map((show) => this.state.shows[show.imdbId]?.episodes ?? [])], this.now());
	}

	/** Reads what is due; a call while one runs is taken up when it ends. `force` (pull to refresh) also reads Trakt and the shows airing now. */
	refresh(shows: readonly CalendarShow[], trakt: TraktReader | null, force = false): Promise<void> {
		if (this.running) {
			this.again = () => this.refresh(shows, trakt, force);
			// Settles with the queued run, so a pull to refresh spins until its own read is done.
			return this.running.then(() => this.running ?? undefined);
		}
		this.running = this.run(shows, trakt, force).finally(() => {
			this.running = null;
			const next = this.again;
			this.again = null;
			if (next) void next().catch(() => undefined);
		});
		return this.running;
	}

	private async run(shows: readonly CalendarShow[], trakt: TraktReader | null, force: boolean): Promise<void> {
		await this.load();
		const now = this.now();
		const from = dayStart(now, -PAST_DAYS);
		const to = dayStart(now, NEXT_DAYS + 1);
		if (!trakt) delete this.state.trakt;
		else if (now - (this.state.trakt?.at ?? 0) >= (force ? FORCED_EVERY : TRAKT_EVERY)) {
			// Trakt's days are UTC days: one more on each side covers every time zone (it serves up to 45).
			const start = new Date(from - DAY).toISOString().slice(0, 10);
			const rows = await trakt.read(`/calendars/my/shows/${start}/${Math.ceil((to - from) / DAY) + 2}`);
			if (Array.isArray(rows)) this.state.trakt = { at: now, episodes: fromTraktCalendar(rows) };
		}
		const covered = new Set(trakt ? (this.state.trakt?.episodes ?? []).map((ep) => ep.imdbId) : []);
		// ponytail: a show that left your list keeps its entry (a few hundred bytes); prune if the file grows past a few MB.
		const due = shows.filter((show) => {
			if (covered.has(show.imdbId)) return false;
			const entry = this.state.shows[show.imdbId];
			return !entry || entry.due <= now || (force && entry.episodes.length > 0 && now - entry.at >= FORCED_EVERY);
		});
		let done = 0;
		let failed = 0;
		const read = async (show: CalendarShow) => {
			try {
				this.state.shows[show.imdbId] = await this.readShow(show, now, from, to);
			} catch {
				failed++;
				const entry = this.state.shows[show.imdbId];
				this.state.shows[show.imdbId] = { at: entry?.at ?? 0, episodes: entry?.episodes ?? [], due: now + RETRY_EVERY };
			}
			if (due.length > 1) this.progress = `Checking your shows ${++done}/${due.length}…`;
			this.changed();
		};
		const queue = [...due];
		await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
			for (let show = queue.shift(); show; show = queue.shift()) await read(show);
		}));
		this.progress = '';
		this.error = failed && failed === due.length ? 'Could not reach DMM for air dates; showing what was read before.' : '';
		await this.store.write(JSON.stringify(this.state)).catch(() => undefined);
		this.changed();
	}

	/** One show: DMM's last and next episode, then, when either falls in the window, those seasons from Trakt. */
	private async readShow(show: CalendarShow, now: number, from: number, to: number): Promise<ShowEntry> {
		const info = await this.get(`${DMM_ORIGIN}/api/info/show?imdbid=${encodeURIComponent(show.imdbId)}`);
		const known = fromShowInfo(show, info);
		const seasons = [...new Set(known.filter((ep) => ep.airsAt >= from && ep.airsAt < to).map((ep) => ep.season))];
		let episodes = known;
		try {
			const lists = await Promise.all(seasons.map((season) => this.get(`${TRAKT_API}/shows/${show.imdbId}/seasons/${season}?extended=full`, TRAKT_PUBLIC)));
			const fromTrakt = lists.flatMap((rows) => (Array.isArray(rows) ? fromTraktSeason(show, rows) : []));
			// Trakt numbers the way release names do and has the air times; DMM's two stay when Trakt has nothing.
			if (fromTrakt.length) episodes = fromTrakt;
		} catch {
			// Trakt unreachable: DMM's last and next episode still say something.
		}
		const kept = episodes.filter((ep) => ep.airsAt >= from && ep.airsAt < to);
		const ended = /ended|cancel/i.test(String(info?.status ?? ''));
		const every = kept.length || known.some((ep) => ep.airsAt >= now) ? ACTIVE_EVERY : ended ? ENDED_EVERY : IDLE_EVERY;
		return { at: now, due: now + every, episodes: kept };
	}
}

export const calendar = new CalendarStore();
