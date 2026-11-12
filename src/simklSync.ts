import { simklLists } from './lists';
import type { TraktReply, TrackerApi } from './trackerSync';
import { watchKey, type WatchedEntry } from './watched';

/** Simkl's side of the tracker sync (src/trackerSync.ts): its activity stamps, history and answers. */
const BUCKETS = ['watching', 'completed', 'hold', 'dropped', 'plantowatch', 'removed_from_list'];
const TYPES = ['movies', 'tv_shows', 'anime'];
/** Every film, show and anime with episodes and IMDb ids; anime with the IMDb-style season and number of each episode. */
export const SIMKL_HISTORY = '/sync/all-items?extended=full_anime_seasons&include_all_episodes=yes&episode_watched_at=yes';

/**
 * /sync/all-items as watched marks, by watchKey (live 2026-11-12): a film once completed, every episode
 * listed (Simkl fills in every episode of a show marked complete in one go), anime episodes by their
 * `tvdb` season and number (Simkl numbers per cour: My Hero Academia S04E14 is its 2019 entry's E14), an
 * anime film as a film. Rows without an IMDb id are left out.
 */
export function watchedFromSimkl(data: any): Map<string, WatchedEntry> {
	const found = new Map<string, WatchedEntry>();
	const film = (row: any, imdbId: unknown) => {
		const watchedAt = Date.parse(row?.last_watched_at);
		if (row?.status === 'completed' && typeof imdbId === 'string' && imdbId && watchedAt) found.set(imdbId, { imdbId, watchedAt });
	};
	for (const row of data?.movies ?? []) film(row, row?.movie?.ids?.imdb);
	for (const [rows, anime] of [[data?.shows, false], [data?.anime, true]] as const) {
		for (const row of rows ?? []) {
			const imdbId = row?.show?.ids?.imdb;
			if (anime && row?.anime_type === 'movie') {
				film(row, imdbId);
				continue;
			}
			if (typeof imdbId !== 'string' || !imdbId) continue;
			for (const season of row?.seasons ?? []) {
				for (const episode of season?.episodes ?? []) {
					const ref = anime ? { imdbId, season: episode?.tvdb?.season, episode: episode?.tvdb?.episode } : { imdbId, season: season?.number, episode: episode?.number };
					const watchedAt = Date.parse(episode?.watched_at) || Date.parse(row?.last_watched_at);
					if (Number.isInteger(ref.season) && Number.isInteger(ref.episode) && watchedAt) found.set(watchKey(ref), { ...ref, watchedAt });
				}
			}
		}
	}
	return found;
}

/** What Simkl's history answer says it does not know: exactly the films, shows and episodes (live 2026-11-12). */
export function simklTook(reply: TraktReply): (entry: WatchedEntry) => boolean {
	const missing = new Set<string>();
	const unknown = reply.data?.not_found ?? {};
	for (const movie of unknown.movies ?? []) missing.add(String(movie?.ids?.imdb));
	for (const show of unknown.shows ?? []) missing.add(`${show?.ids?.imdb}:*`);
	for (const show of unknown.episodes ?? []) {
		for (const season of show?.seasons ?? []) for (const episode of season?.episodes ?? []) missing.add(watchKey({ imdbId: show?.ids?.imdb, season: season?.number, episode: episode?.number }));
	}
	return (entry) => !missing.has(watchKey(entry)) && !(entry.season !== undefined && missing.has(`${entry.imdbId}:*`));
}

/** Not `all`: it also moves on ratings, lists and resume points, and each move costs a whole-history read. */
const statusStamp = (data: any) => JSON.stringify(TYPES.map((type) => BUCKETS.map((bucket) => data?.[type]?.[bucket] ?? null)));

export const SIMKL: TrackerApi = {
	id: 'simkl',
	name: 'Simkl',
	// Simkl asks apps to check on start and coming back at most every 15-30 minutes (API rules, 2026).
	checkEveryMs: 15 * 60_000,
	startAfterSeek: false,
	refusals: {
		403: 'Simkl lets DMM Mobile only read your library. Disconnect and connect Simkl again to allow updates.',
		423: 'Simkl locked your account (423); Simkl support can unlock it.',
	},
	activities: '/sync/activities',
	stamps: (data) => ({
		watched: statusStamp(data),
		paused: TYPES.map((type) => data?.[type]?.playback).join('|'),
	}),
	// ponytail: the whole history on every change, as DMM's Kodi addon reads it; Simkl prefers date_from deltas
	// (an anime cour then covers only its own seasons). Worth it if large libraries make this slow.
	history: async (get) => watchedFromSimkl(await get(SIMKL_HISTORY)),
	took: simklTook,
	// Its statuses (Plan to Watch, Watching...) are its lists: the same stamps and the same answer as the history.
	// ponytail: Simkl's custom lists are left out: their items are PRO/VIP only (a free account gets 200 premium_only).
	lists: { stamp: statusStamp, read: async (get) => simklLists(await get(SIMKL_HISTORY)) },
};
