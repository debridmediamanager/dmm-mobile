import { describe, expect, it } from 'vitest';
import anime from './test/fixtures/anime-search-baka-to-test-2026-11-09.json';
import trakt from './test/fixtures/trakt-search-test-2026-11-09.json';
import { animePagePath, dmmPageUrl, imdbIdIn, searchAnime, searchTitles } from './search';

const answer = (status: number, body: unknown) => async () => ({ status, json: async () => body });

describe('searchTitles', () => {
	// DMM's /api/trakt/search for "test", as captured: shows and movies with posters, one with no IMDb id.
	it('turns Trakt results into DMM pages, posters included', async () => {
		const rows = await searchTitles('test', answer(200, trakt));

		expect(rows[0]).toEqual({
			key: 'show-tt22003362',
			title: "Special Forces: World's Toughest Test",
			year: 2023,
			badge: 'Show',
			anime: false,
			poster: 'https://media.trakt.tv/shows/200996/medium/poster.webp',
			path: '/show/tt22003362',
		});
		expect(rows.some((row) => row.path.startsWith('/movie/tt'))).toBe(true);
		// No IMDb id: DMM web sends those to its search page.
		expect(rows.at(-1)?.path).toMatch(/^\/search\?query=/);
	});

	it('says so when DMM refuses', async () => {
		await expect(searchTitles('test', answer(503, {}))).rejects.toThrow('Search failed (503)');
	});
});

describe('searchAnime', () => {
	it('keeps three rows with a page, once each, as DMM web does', async () => {
		const rows = await searchAnime('Baka to Test', answer(200, anime));

		expect(rows.map((row) => [row.path, row.badge])).toEqual([
			['/anime/6747', 'TV'],
			['/anime/8235', 'TV'],
			['/anime/mal-10431', 'ONA'],
		]);
		expect(rows[0].poster).toMatch(/^https:\/\/media\.kitsu\.app\//);
	});

	it('leaves two letters to Trakt', async () => {
		expect(await searchAnime('ba', () => Promise.reject(new Error('asked')))).toEqual([]);
	});

	it('skips a row with no page', () => {
		expect(animePagePath('anime:mal-null')).toBeNull();
	});
});

describe('imdbIdIn', () => {
	it('finds a typed or pasted IMDb id', () => {
		expect(imdbIdIn('https://www.imdb.com/title/tt0111161/')).toBe('tt0111161');
		expect(imdbIdIn('test')).toBeNull();
	});
});

describe('dmmPageUrl', () => {
	const STATE = { 'rd:refreshToken': '"RT"' };

	it('hands the app state over and puts the code in the fragment', async () => {
		let sent: unknown;
		const url = await dmmPageUrl('/movie/tt0111161', STATE, async (_url, init) => {
			sent = JSON.parse(init!.body);
			return { status: 200, json: async () => ({ code: 'C0DE' }) };
		});

		expect(sent).toEqual({ state: STATE });
		expect(url).toBe('https://debridmediamanager.com/movie/tt0111161#handoff=C0DE');
	});

	it('still opens the page, signed out, when DMM cannot take the handoff', async () => {
		expect(await dmmPageUrl('/movie/tt0111161', STATE, answer(503, {}))).toBe('https://debridmediamanager.com/movie/tt0111161');
		expect(await dmmPageUrl('/movie/tt0111161', STATE, () => Promise.reject(new Error('offline')))).toBe('https://debridmediamanager.com/movie/tt0111161');
	});
});
