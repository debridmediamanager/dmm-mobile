import type { LibraryFile, LibraryItem, ProviderId } from './model';
import type { SessionApi } from './session';
import type { Identification } from './titles';

/**
 * The demo library: entered as the API key of any provider, it signs in to a library of
 * Blender's open movies (CC BY) whose files really play, streamed from the Internet Archive.
 * It is what App Store and Google Play review sign in with (docs/store/review.md), from any
 * IP, without a debrid account. No provider is called for it and it never reaches DMM's sync.
 */
export const DEMO_KEY = 'dmmdemo';

export const isDemoToken = (token: string | undefined): boolean => token?.trim().toLowerCase() === DEMO_KEY;

const MB = 1024 ** 2;
const ARCHIVE = 'https://archive.org/download';
const TOS_SUBS = 'https://download.blender.org/demo/movies/ToS/subtitles';

interface DemoFile {
	name: string;
	size: number;
	url: string;
}

interface DemoTitle {
	title: string;
	/** Named here rather than by DMM: the demo key is no login, so the app cannot ask. */
	named: Identification;
	/** The release's real BitTorrent info hash (the WebTorrent free-media set), so sharing gives a working magnet. */
	hash: string;
	added: string;
	files: DemoFile[];
	downloading?: boolean;
}

const TITLES: DemoTitle[] = [
	{
		title: 'Tears of Steel (2012) 1080p',
		named: { imdbId: 'tt2285752', title: 'Tears of Steel', year: 2012, kind: 'movie' },
		hash: '209c8226b299b308beaf2b9cd3fb49212dbd13ec',
		added: '2026-11-09T09:12:00Z',
		files: [
			{ name: 'tears_of_steel_1080p.mp4', size: 76_119_705, url: `${ARCHIVE}/Tears-of-Steel/tears_of_steel_1080p.mp4` },
			{ name: 'tears_of_steel.en.srt', size: 4_764, url: `${TOS_SUBS}/TOS-en.srt` },
			{ name: 'tears_of_steel.de.srt', size: 4_851, url: `${TOS_SUBS}/TOS-de.srt` },
			{ name: 'tears_of_steel.es.srt', size: 4_948, url: `${TOS_SUBS}/TOS-es.srt` },
		],
	},
	{
		title: 'Sintel (2010) 2K',
		named: { imdbId: 'tt1727587', title: 'Sintel', year: 2010, kind: 'movie' },
		hash: '08ada5a7a6183aae1e09d831df6748d566095a10',
		added: '2026-11-08T18:22:00Z',
		files: [{ name: 'sintel-2048-stereo.mp4', size: 282_690_045, url: `${ARCHIVE}/Sintel/sintel-2048-stereo.mp4` }],
	},
	{
		title: 'Big Buck Bunny (2008) 720p',
		named: { imdbId: 'tt1254207', title: 'Big Buck Bunny', year: 2008, kind: 'movie' },
		hash: 'dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c',
		added: '2026-11-06T16:30:00Z',
		files: [{ name: 'big_buck_bunny_720p_surround.mp4', size: 61_878_609, url: `${ARCHIVE}/BigBuckBunny_124/Content/big_buck_bunny_720p_surround.mp4` }],
	},
	{
		title: 'Cosmos Laundromat (2015)',
		named: { imdbId: 'tt4957236', title: 'Cosmos Laundromat', year: 2015, kind: 'movie' },
		hash: 'c9e15763f722f23e98a29decdfae341b98d53056',
		added: '2026-11-01T09:00:00Z',
		files: [{ name: 'Cosmos Laundromat.mp4', size: 220 * MB, url: '' }],
		downloading: true,
	},
];

/** The title of a demo release, by its hash; the same releases in a real library are these films too. */
export const demoIdentification = (hash: string): Identification | undefined => TITLES.find((title) => title.hash === hash.toLowerCase())?.named;

const sizeOf = (files: readonly LibraryFile[]) => files.reduce((total, file) => total + file.size, 0);

function demoItem(provider: ProviderId, title: DemoTitle, index: number): LibraryItem {
	const files: LibraryFile[] = title.files.map((file, fileIndex) => ({ id: String(fileIndex + 1), name: file.name, size: file.size, link: file.url || undefined, selected: true }));
	return {
		id: `${provider}:demo${index + 1}`,
		provider,
		title: title.title,
		filename: title.title,
		hash: title.hash,
		size: sizeOf(files),
		progress: title.downloading ? 62 : 100,
		status: title.downloading ? 'downloading' : 'finished',
		serviceStatus: title.downloading ? 'downloading' : 'downloaded',
		added: title.added,
		files,
		filesLoaded: true,
		kind: 'torrent',
		...(title.downloading ? { speed: 12 * MB, seeders: 48 } : {}),
	};
}

/** Each provider signed in with the demo key keeps its own copy, so adds and deletes last until the app is closed. */
const libraries = new Map<ProviderId, LibraryItem[]>();
let added = 0;

function library(provider: ProviderId): LibraryItem[] {
	let items = libraries.get(provider);
	if (!items) {
		items = TITLES.map((title, index) => demoItem(provider, title, index));
		libraries.set(provider, items);
	}
	return items;
}

const copy = (item: LibraryItem): LibraryItem => ({ ...item, files: item.files.map((file) => ({ ...file })) });

function find(provider: ProviderId, itemId: string): LibraryItem {
	const item = library(provider).find((entry) => entry.id === itemId);
	if (!item) throw new Error('That item is no longer in the demo library.');
	return item;
}

/** An added magnet, file or link shows as queued: the demo downloads nothing. */
function addQueued(provider: ProviderId, name: string, hash = '') {
	added += 1;
	library(provider).unshift({
		id: `${provider}:demo-added${added}`,
		provider,
		title: name,
		filename: name,
		hash,
		size: 0,
		progress: 0,
		status: 'waiting',
		serviceStatus: 'queued (demo)',
		added: new Date().toISOString(),
		files: [],
		filesLoaded: true,
		kind: 'torrent',
	});
}

function magnetName(magnetOrHash: string): { name: string; hash: string } {
	const hash = /urn:btih:([0-9a-z]{32,40})/i.exec(magnetOrHash)?.[1] ?? (/^[0-9a-f]{40}$/i.test(magnetOrHash.trim()) ? magnetOrHash.trim() : '');
	const dn = /[?&]dn=([^&]+)/.exec(magnetOrHash)?.[1];
	let name = hash || 'Magnet';
	if (dn) {
		try {
			name = decodeURIComponent(dn.replace(/\+/g, ' '));
		} catch {
			name = dn;
		}
	}
	return { name, hash: hash.toLowerCase() };
}

/** The provider API, except that the demo key is answered from the demo library. */
export function withDemo(api: SessionApi): SessionApi {
	return {
		validateCredential: async (provider, token, signal) => (isDemoToken(token) ? { label: 'Demo library' } : api.validateCredential(provider, token, signal)),
		listLibrary: async (provider, token, signal) => (isDemoToken(token) ? library(provider).map(copy) : api.listLibrary(provider, token, signal)),
		getLibraryDetail: async (provider, token, itemId, signal) => (isDemoToken(token) ? copy(find(provider, itemId)) : api.getLibraryDetail(provider, token, itemId, signal)),
		resolveFile: async (provider, token, item, fileId, signal) => {
			if (!isDemoToken(token)) return api.resolveFile(provider, token, item, fileId, signal);
			const link = find(provider, item.id).files.find((file) => file.id === fileId)?.link;
			if (!link) throw new Error('This demo file is still downloading.');
			return link;
		},
		addMagnet: async (provider, token, magnetOrHash, signal, options) => {
			if (!isDemoToken(token)) return api.addMagnet(provider, token, magnetOrHash, signal, options);
			const { name, hash } = magnetName(magnetOrHash);
			addQueued(provider, name, hash);
		},
		deleteLibraryItem: async (provider, token, itemId, signal) => {
			if (!isDemoToken(token)) return api.deleteLibraryItem(provider, token, itemId, signal);
			const items = library(provider);
			const index = items.findIndex((entry) => entry.id === itemId);
			if (index >= 0) items.splice(index, 1);
		},
		selectRealDebridFiles: async (token, itemId, fileIds, signal) => {
			if (!isDemoToken(token)) return api.selectRealDebridFiles(token, itemId, fileIds, signal);
			const item = find('rd', itemId);
			for (const file of item.files) file.selected = fileIds.includes(file.id);
		},
		renewCredential: async (provider, credential, ...rest) => (isDemoToken(credential.token) ? credential : api.renewCredential(provider, credential, ...rest)),
		addTorrentFile: async (provider, token, file, signal) => (isDemoToken(token) ? addQueued(provider, file.name.replace(/\.torrent$/i, '')) : api.addTorrentFile(provider, token, file, signal)),
		addWebDownload: async (token, link, signal) => (isDemoToken(token) ? addQueued('tb', link.split('/').pop() || link) : api.addWebDownload(token, link, signal)),
		reinsertItem: async (token, item, fileIds, signal) => (isDemoToken(token) ? undefined : api.reinsertItem(token, item, fileIds, signal)),
		findRealDebridUncached: async (token, onProgress, signal) => (isDemoToken(token) ? new Set<string>() : api.findRealDebridUncached(token, onProgress, signal)),
	};
}

/** Forget every change made to the demo libraries. Tests only. */
export function resetDemo(): void {
	libraries.clear();
	added = 0;
}
