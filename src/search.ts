import type { BrowserState } from './sync';
import { DMM_ORIGIN } from './tvLink';

/**
 * The Search tab: DMM web's quick search (its header dropdown), whose rows open DMM's own
 * pages in the browser, signed in as the app is.
 */
export interface SearchRow {
	key: string;
	title: string;
	year?: number;
	/** Movie, Show, or an anime type: TV, OVA, ONA, Movie, Special. */
	badge: string;
	anime: boolean;
	poster?: string;
	/** The DMM page, e.g. /movie/tt0111161. */
	path: string;
}

type Fetch = (url: string, init?: { method: 'POST'; headers: Record<string, string>; body: string }) => Promise<{ status: number; json(): Promise<unknown> }>;
const defaultFetch = fetch as unknown as Fetch;

/** As DMM web: two letters of a romanized title match almost any anime, so those go to Trakt only. */
export const ANIME_MIN_LENGTH = 3;
export const ANIME_LIMIT = 3;

/** A typed IMDb id goes straight to its page, as on DMM web. */
export const imdbIdIn = (query: string): string | null => /(tt\d{7,})/.exec(query)?.[1] ?? null;

interface TraktMedia {
	title?: string;
	year?: number;
	ids?: { imdb?: string };
	images?: { poster?: string[] };
}

export async function searchTitles(query: string, fetcher: Fetch = defaultFetch): Promise<SearchRow[]> {
	const res = await fetcher(`${DMM_ORIGIN}/api/trakt/search?query=${encodeURIComponent(query)}&types=movie,show`);
	if (res.status !== 200) throw new Error(`Search failed (${res.status}). Try again in a minute.`);
	const results = await res.json();
	if (!Array.isArray(results)) return [];
	return results.flatMap((result: { type?: string; movie?: TraktMedia; show?: TraktMedia }, index): SearchRow[] => {
		const type = result.type === 'show' ? 'show' : 'movie';
		const media = result[type];
		if (!media?.title) return [];
		const imdb = media.ids?.imdb;
		const poster = media.images?.poster?.[0];
		return [{
			key: `${type}-${imdb ?? index}`,
			title: media.title,
			year: media.year,
			badge: type === 'show' ? 'Show' : 'Movie',
			anime: false,
			poster: poster ? `https://${poster}` : undefined,
			path: imdb ? `/${type}/${imdb}` : `/search?query=${encodeURIComponent(media.title)}`,
		}];
	});
}

/** DMM web's animePagePath: anime:anidb-17617 is /anime/17617, anime:mal-1278 is /anime/mal-1278. */
export function animePagePath(id: string): string | null {
	const anidb = /^anime:anidb-(\d+)$/.exec(id)?.[1];
	if (anidb) return `/anime/${anidb}`;
	const mal = /^anime:mal-(\d+)$/.exec(id)?.[1];
	return mal ? `/anime/mal-${mal}` : null;
}

const ANIME_TYPES: Record<string, string> = { TV: 'TV', OVA: 'OVA', ONA: 'ONA', MOVIE: 'Movie', SPECIAL: 'Special' };

export async function searchAnime(query: string, fetcher: Fetch = defaultFetch): Promise<SearchRow[]> {
	const keyword = query.trim().toLocaleLowerCase();
	if (keyword.length < ANIME_MIN_LENGTH) return [];
	const res = await fetcher(`${DMM_ORIGIN}/api/search/anime?keyword=${encodeURIComponent(keyword)}`);
	if (res.status !== 200) throw new Error(`Anime search failed (${res.status}).`);
	const body = (await res.json()) as { results?: unknown };
	const rows: SearchRow[] = [];
	for (const result of Array.isArray(body?.results) ? (body.results as { id?: unknown; title?: unknown; type?: string; poster_url?: string }[]) : []) {
		if (typeof result?.id !== 'string' || typeof result.title !== 'string') continue;
		const path = animePagePath(result.id);
		// Search names a row with neither an AniDB nor a MAL id anime:mal-null; it has no page.
		if (!path || rows.some((row) => row.path === path)) continue;
		rows.push({ key: result.id, title: result.title, badge: ANIME_TYPES[(result.type ?? '').toUpperCase()] ?? 'Anime', anime: true, poster: result.poster_url || undefined, path });
		if (rows.length === ANIME_LIMIT) break;
	}
	return rows;
}

/**
 * The page's link, carrying a one-time code that signs the browser in with the app's logins
 * (DMM's /api/handoff). Without a code (DMM unreachable, nothing to hand over) the page still
 * opens, signed out, rather than not at all.
 */
export async function dmmPageUrl(path: string, state: BrowserState, fetcher: Fetch = defaultFetch): Promise<string> {
	const url = `${DMM_ORIGIN}${path}`;
	try {
		const res = await fetcher(`${DMM_ORIGIN}/api/handoff`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state }) });
		const body = (await res.json().catch(() => ({}))) as { code?: unknown };
		return res.status === 200 && typeof body.code === 'string' ? `${url}#handoff=${body.code}` : url;
	} catch {
		return url;
	}
}
