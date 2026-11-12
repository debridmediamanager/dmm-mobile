import type { LibraryFile, LibraryItem } from './model';
import { filePath, isVideoName, mediaTypeOf } from './core';
import type { SyncIdentity } from './sync';
import { DMM_ORIGIN } from './tvLink';

/**
 * The library by title: which film or show each release is (DMM's library identification),
 * and which episode each file of a show is (read from its name here).
 */

/** What DMM's /api/library/identify answers for a release it is sure of. */
export interface Identification {
	imdbId: string;
	title: string;
	year: number | null;
	kind: 'movie' | 'tv';
	/** A show's seasons, read by DMM from the release name. */
	seasons?: number[];
}

/** DMM keeps its answers per hash and name; a hashless release (Premiumize, Offcloud) is keyed by name alone. */
export const identificationKey = (item: Pick<LibraryItem, 'hash' | 'filename'>): string => `${item.hash.toLowerCase()}|${item.filename}`;

/** DMM web's `identifiable`: films and shows with a real release name. */
export const identifiable = (item: LibraryItem): boolean =>
	mediaTypeOf(item) !== 'other' &&
	Boolean(item.filename.trim()) &&
	item.filename.toLowerCase() !== item.hash.toLowerCase() &&
	!/^magnet/i.test(item.filename) &&
	!['Invalid Magnet', 'noname'].includes(item.filename);

interface Response {
	status: number;
	ok: boolean;
	headers: { get(name: string): string | null };
	json(): Promise<unknown>;
}
export type Post = (url: string, body: unknown) => Promise<Response>;

/** DMM did not accept the login it was shown; another of the user's logins may pass. */
export class LoginRefused extends Error {}

const defaultPost: Post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The routes' own batch sizes: stored answers 5,000 a call (5 a minute), the identifier 500 a call (10 a minute). */
export const STORED_BATCH = 5000;
export const IDENTIFY_BATCH = 500;
const MAX_REFUSALS = 5;

/**
 * Asks DMM which film or show each release is, as DMM web's pages do: the answers it has stored
 * first, then its identifier for the rest. `identity` is a provider login the app syncs with:
 * DMM serves the app only with one. A batch the rate limit refuses waits out Retry-After and is
 * asked again. `onAnswers` gets each batch's answers by key; a null is final (nothing found), so
 * names the identifier could not be asked about (`complete: false`) are left out.
 */
export async function askDmm(
	items: readonly LibraryItem[],
	identity: SyncIdentity,
	onAnswers: (answers: Map<string, Identification | null>) => void,
	post: Post = defaultPost,
	wait: (ms: number) => Promise<unknown> = sleep
): Promise<void> {
	const unique = [...new Map(items.map((item) => [identificationKey(item), item])).values()];
	const ask = async (route: string, batch: LibraryItem[]): Promise<{ results: (Identification | null)[]; complete: boolean } | null> => {
		for (let refusals = 0; refusals < MAX_REFUSALS; refusals++) {
			const response = await post(`${DMM_ORIGIN}${route}`, { items: batch.map((item) => ({ filename: item.filename, ...(item.hash ? { hash: item.hash } : {}) })), identity });
			if (response.status === 429) {
				await wait(Math.min(Number(response.headers.get('retry-after')) || 10, 60) * 1000);
				continue;
			}
			// A refused login refuses every batch.
			if (response.status === 401 || response.status === 403) throw new LoginRefused(`DMM refused library identification (${response.status}).`);
			if (!response.ok) return null;
			const body = (await response.json()) as { results?: (Identification | null)[]; complete?: boolean };
			return Array.isArray(body.results) && body.results.length === batch.length ? { results: body.results, complete: body.complete !== false } : null;
		}
		return null;
	};
	const unanswered: LibraryItem[] = unique.filter((item) => !item.hash);
	const hashed = unique.filter((item) => item.hash);
	for (let at = 0; at < hashed.length; at += STORED_BATCH) {
		const batch = hashed.slice(at, at + STORED_BATCH);
		const answer = await ask('/api/library/identified', batch);
		const found = new Map<string, Identification>();
		batch.forEach((item, n) => {
			const result = answer?.results[n];
			if (result) found.set(identificationKey(item), result);
			else unanswered.push(item);
		});
		if (found.size) onAnswers(found);
	}
	for (let at = 0; at < unanswered.length; at += IDENTIFY_BATCH) {
		const batch = unanswered.slice(at, at + IDENTIFY_BATCH);
		const answer = await ask('/api/library/identify', batch);
		if (!answer) continue;
		const answers = new Map<string, Identification | null>();
		batch.forEach((item, n) => {
			if (answer.results[n] || answer.complete) answers.set(identificationKey(item), answer.results[n] ?? null);
		});
		if (answers.size) onAnswers(answers);
	}
}

/** A film's or show's page facts from DMM's /api/info/movie and /api/info/show. */
export interface TitleInfo {
	title?: string;
	description?: string;
	poster?: string;
	backdrop?: string;
	year?: number;
	/** Episodes per season by TMDB, shows only. */
	season_episode_counts?: Record<string, number>;
}

export async function fetchTitleInfo(imdbId: string, kind: 'movie' | 'tv', get: (url: string) => Promise<Response> = (url) => fetch(url)): Promise<TitleInfo> {
	const response = await get(`${DMM_ORIGIN}/api/info/${kind === 'tv' ? 'show' : 'movie'}?imdbid=${encodeURIComponent(imdbId)}`);
	if (!response.ok) throw new Error(`DMM has no details for this title (${response.status}).`);
	return (await response.json()) as TitleInfo;
}

/**
 * A title's poster as DMM web's poster component loads it, no API call: DMM's poster CDN
 * (posters0…9, spread by the id's digits, DMM web's posterHost), then metahub, which it mirrors.
 */
export function posterUrls(imdbId: string): string[] {
	let hash = 0;
	for (const digit of imdbId.replace(/[^0-9]/g, '')) hash = ((hash << 5) - hash + Number(digit)) | 0;
	return [`https://posters${Math.abs(hash) % 10}.debridmediamanager.com/${imdbId}-small.jpg`, `https://images.metahub.space/poster/small/${imdbId}/img`];
}

/** TMDB's originals are several megabytes; the page shows a phone-sized copy. */
export const smallerTmdb = (url: string | undefined, size: string): string | undefined => url?.replace('/t/p/original/', `/t/p/${size}/`);

export interface EpisodeRef {
	season: number;
	episode: number;
	/** The last episode of a multi-episode file (S08E12-E13). */
	end?: number;
	/** Placed by a bare number in a season the name only implies: checked against the show's episode counts. */
	inferred?: boolean;
}

const SXXEYY = /\bs(\d{1,2})[ ._-]?e(\d{1,3})(?:-?e(\d{1,3})|-(\d{1,3})(?![\dp]))?/i;
// "1x06-07" is a double episode
const NXNN = /(?:^|[^\d.])(\d{1,2})x(\d{2,3})(?:-(\d{2,3}))?(?![\dp])/i;
// a fansub's "Chihayafuru S1 - 24"
const FANSUB = /\bs(\d{1,2}) - (\d{1,3})(?:v\d)?(?![\d])/i;
const SEASON_WORD = /\bseason[ ._-]?(\d{1,2})\b|\b(\d{1,2})(?:st|nd|rd|th) season\b/i;
const SEASON_TAG = /(?:^|[ ._([-])s(\d{1,2})(?=$|[ ._)\]-])/i;
const EPISODE_WORD = /\b(?:episode|ep)[ ._]?(\d{1,3})\b|\be(\d{2,3})\b/i;
// a fansub's bare episode, "Heidi - 01" or "2nd Season - 01 [1080p]"
const BARE_EPISODE = / - (\d{2,3})(?:v\d)?(?=$|[ .[(])/;

const seasonIn = (text: string): number | null => {
	const word = SEASON_WORD.exec(text);
	if (word) return Number(word[1] ?? word[2]);
	const tag = SEASON_TAG.exec(text);
	return tag ? Number(tag[1]) : null;
};

/** The single season a release name gives ("Show.S02.1080p", "Season 3"), or null for none or several. */
export function releaseSeason(name: string): number | null {
	if (/\bs\d{1,2}\s?-\s?s?\d{1,2}\b|seasons|complete series/i.test(name)) return null;
	return seasonIn(name);
}

/**
 * The season and episode a show's file is, from its own name, then its folders, then the one
 * season its release names. Absolute numbering ("Boku no Hero Academia - 168") has no season to
 * go by, so it is left unplaced rather than guessed.
 */
export function episodeOf(path: string, fallbackSeason: number | null = null): EpisodeRef | null {
	const parts = path.split('/').filter(Boolean);
	const base = (parts.pop() ?? '').replace(/\.[a-z0-9]{2,4}$/i, '');
	const folders = parts.join('/');
	const explicit = (text: string): EpisodeRef | null => {
		const sxe = SXXEYY.exec(text);
		if (sxe) {
			const episode = Number(sxe[2]);
			const end = Number(sxe[3] ?? sxe[4]);
			return { season: Number(sxe[1]), episode, ...(end > episode ? { end } : {}) };
		}
		const nxn = NXNN.exec(text);
		if (nxn) {
			const episode = Number(nxn[2]);
			return { season: Number(nxn[1]), episode, ...(Number(nxn[3]) > episode ? { end: Number(nxn[3]) } : {}) };
		}
		const fansub = FANSUB.exec(text);
		return fansub ? { season: Number(fansub[1]), episode: Number(fansub[2]) } : null;
	};
	const own = explicit(base);
	if (own) return own;
	const word = EPISODE_WORD.exec(base);
	const bare = word ? null : BARE_EPISODE.exec(base);
	const episode = word ? Number(word[1] ?? word[2]) : bare ? Number(bare[1]) : null;
	if (episode !== null) {
		const named = seasonIn(base) ?? seasonIn(folders);
		if (named !== null) return { season: named, episode };
		if (fallbackSeason !== null) return { season: fallbackSeason, episode, inferred: true };
	}
	// a scene episode in its own folder with an obfuscated file name
	return explicit(folders);
}

const RESOLUTIONS: [string, RegExp][] = [['4K', /\b(2160p|4k|uhd)\b/i], ['1080p', /1080[pi]|1920x1080/i], ['720p', /720p|1280x720/i], ['SD', /\b(480p|576p|dvd)/i]];

/**
 * The resolution and the tags worth choosing a copy by, from the first name that gives one
 * resolution: a file's own name, then its release's. A range ("1080p-2160p") says nothing.
 */
export function qualityOf(...names: string[]): string {
	const resolution = names.map((name) => RESOLUTIONS.filter(([, pattern]) => pattern.test(name))).find((found) => found.length === 1)?.[0][0] ?? '';
	const all = names.join(' ');
	const tags = [/remux/i.test(all) ? 'Remux' : '', /\b(dv|dovi|dolby.?vision)\b/i.test(all) ? 'DV' : /\bhdr/i.test(all) ? 'HDR' : ''];
	return [resolution, ...tags].filter(Boolean).join(' ');
}

/** The files of a copy worth opening: videos, no samples, and on Real-Debrid only selected ones (the rest have no link). */
export const playableFiles = (item: LibraryItem, files: readonly LibraryFile[]): LibraryFile[] =>
	files.filter((file) => isVideoName(file.name) && !(/\bsample\b/i.test(file.name) && file.size < 300 * 1024 ** 2) && !(item.provider === 'rd' && file.selected === false));

export interface TitleGroup {
	imdbId: string;
	title: string;
	year: number | null;
	kind: 'movie' | 'tv';
	/** Every release of it, across providers. */
	items: LibraryItem[];
	/** When its newest release was added. */
	added: number;
	/** A show's seasons, as the release names give them. */
	seasons: number[];
}

/** Films and shows from the library, newest first; releases DMM could not name stay in `other`, in their order. */
export function groupTitles(items: readonly LibraryItem[], identify: (item: LibraryItem) => Identification | null | undefined): { titles: TitleGroup[]; other: LibraryItem[] } {
	const groups = new Map<string, TitleGroup>();
	const other: LibraryItem[] = [];
	for (const item of items) {
		const found = identify(item);
		if (!found) {
			other.push(item);
			continue;
		}
		let group = groups.get(found.imdbId);
		if (!group) groups.set(found.imdbId, (group = { imdbId: found.imdbId, title: found.title, year: found.year, kind: found.kind, items: [], added: 0, seasons: [] }));
		group.items.push(item);
		group.added = Math.max(group.added, Date.parse(item.added) || 0);
		// DMM's stored answers carry no seasons (only its identifier reads them): a one-season release name still gives one.
		const single = found.kind === 'tv' && !found.seasons ? releaseSeason(item.filename) : null;
		for (const season of found.seasons ?? (single === null ? [] : [single])) if (!group.seasons.includes(season)) group.seasons.push(season);
	}
	const titles = [...groups.values()];
	for (const group of titles) group.seasons.sort((a, b) => a - b);
	titles.sort((a, b) => b.added - a.added);
	return { titles, other };
}

/** "S1–3", "S2, S5", or "" for none. */
export function seasonRange(seasons: readonly number[]): string {
	if (seasons.length === 0) return '';
	const contiguous = seasons.every((season, n) => n === 0 || season === seasons[n - 1] + 1);
	return contiguous && seasons.length > 2 ? `S${seasons[0]}–${seasons[seasons.length - 1]}` : seasons.map((season) => `S${season}`).join(', ');
}

export interface EpisodeCopy {
	item: LibraryItem;
	file: LibraryFile;
	quality: string;
	ref: EpisodeRef | null;
	/** The file's name and its folder: a pack's extras repeat names ("S12 Extras/Season Preview.mkv"). */
	label: string;
}

export interface ShowEpisodes {
	/** season -> episode -> copies, both in number order. */
	seasons: Map<number, Map<number, EpisodeCopy[]>>;
	/** Files with no season and episode to go by: absolute numbering, extras, films. */
	unplaced: EpisodeCopy[];
}

/**
 * A show's episodes across all its releases and providers. `counts` (TMDB's episodes per season,
 * from DMM) moves a file placed only by a bare number past its season's end to `unplaced`.
 */
export function showEpisodes(copies: readonly { item: LibraryItem; files: readonly LibraryFile[]; seasons?: readonly number[] }[], counts?: Record<string, number>): ShowEpisodes {
	const seasons = new Map<number, Map<number, EpisodeCopy[]>>();
	const unplaced: EpisodeCopy[] = [];
	for (const { item, files, seasons: named } of copies) {
		const fallback = named?.length === 1 ? named[0] : releaseSeason(item.filename);
		for (const file of playableFiles(item, files)) {
			const path = filePath(file.name, file.path);
			let ref = episodeOf(path, fallback);
			const count = ref?.inferred ? counts?.[String(ref.season)] : undefined;
			if (ref && count !== undefined && ref.episode > count) ref = null;
			const copy: EpisodeCopy = { item, file, quality: qualityOf(path, item.filename), ref, label: path.split('/').filter(Boolean).slice(-2).join('/') };
			if (!ref) {
				unplaced.push(copy);
				continue;
			}
			let episodes = seasons.get(ref.season);
			if (!episodes) seasons.set(ref.season, (episodes = new Map()));
			episodes.set(ref.episode, [...(episodes.get(ref.episode) ?? []), copy]);
		}
	}
	const sorted = new Map([...seasons.entries()].sort(([a], [b]) => a - b).map(([season, episodes]) => [season, new Map([...episodes.entries()].sort(([a], [b]) => a - b))]));
	return { seasons: sorted, unplaced };
}

/** The file a film copy opens: its biggest playable video. */
export const mainFile = (item: LibraryItem, files: readonly LibraryFile[]): LibraryFile | undefined =>
	[...playableFiles(item, files)].sort((a, b) => b.size - a.size)[0];
