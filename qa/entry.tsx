import { SafeAreaProvider } from 'react-native-safe-area-context';
import { registerRootComponent } from 'expo';
import { AppNavigation } from '../src/App';
import { AppProvider } from '../src/AppContext';
import type { LibraryFile, LibraryItem, ProviderId } from '../src/model';
import { PROVIDERS, PROVIDER_META } from '../src/model';
import type { CredentialStorage } from '../src/storage';
import { LibrarySession, type SessionApi } from '../src/session';
import rdFixture from '../src/test/fixtures/rd-bdmv-single-selection-2026-10-12.json';
import adFilesFixture from '../src/test/fixtures/adfiles.json';
import adStatusFixture from '../src/test/fixtures/adstatus.json';

const rdRow = Object.values(rdFixture.info)[0];
const adLeaf = adFilesFixture.data.magnets[0].files[0].e[1];
const file = (id: string, name: string, size: number, link = `https://files.example.invalid/${id}`): LibraryFile => ({ id, name, size, link });

const rdFiles: LibraryFile[] = rdRow.files.slice(0, 3).map((entry) => file(String(entry.id), entry.path, entry.bytes, 'https://files.example.invalid/rd-media'));
const adFiles: LibraryFile[] = [file('movie', adLeaf.n, adLeaf.s, 'https://files.example.invalid/ad-media')];
const fixtureDate = rdRow.added;

const items: LibraryItem[] = [
	{
		id: `rd:${rdRow.id}`,
		provider: 'rd',
		title: 'The Matrix · UHD fixture',
		filename: rdRow.filename,
		hash: rdRow.hash,
		size: rdRow.bytes,
		progress: 100,
		status: 'finished',
		serviceStatus: 'downloaded',
		added: fixtureDate,
		files: rdFiles,
		filesLoaded: true,
		kind: 'torrent',
	},
	{
		id: `ad:${adStatusFixture.id}`,
		provider: 'ad',
		title: 'The Breadwinner · AD fixture',
		filename: adStatusFixture.filename,
		hash: adStatusFixture.hash,
		size: adStatusFixture.size,
		progress: 100,
		status: 'finished',
		serviceStatus: adStatusFixture.status,
		added: new Date(adStatusFixture.uploadDate * 1000).toISOString(),
		files: adFiles,
		filesLoaded: true,
		kind: 'torrent',
	},
	{
		id: 'tb:qa-torrent',
		provider: 'tb',
		title: 'TorBox · Matrix companion',
		filename: 'The.Matrix.1999.2160p.mkv',
		hash: rdRow.hash,
		size: 28100000000,
		progress: 62,
		status: 'downloading',
		serviceStatus: 'downloading',
		added: '2026-11-05T12:00:00.000Z',
		files: [file('tb-media', 'The.Matrix.1999.2160p.mkv', 28100000000)],
		filesLoaded: true,
		kind: 'torrent',
	},
	{
		id: 'pm:t:qa-transfer',
		provider: 'pm',
		title: 'Premiumize · Alpha transfer',
		filename: 'Alpha (2026).mkv',
		hash: adStatusFixture.hash,
		size: 3425691137,
		progress: 100,
		status: 'finished',
		serviceStatus: 'finished',
		added: '2026-11-04T03:22:54.000Z',
		files: [file('pm-media', 'Alpha (2026).mkv', 3425691137)],
		filesLoaded: true,
		kind: 'transfer',
	},
	{
		id: 'oc:qa-request',
		provider: 'oc',
		title: 'Offcloud · queue example',
		filename: 'My.Hero.Academia.S04.P2',
		hash: rdRow.hash,
		size: 32397157962,
		progress: 18,
		status: 'waiting',
		serviceStatus: 'queued',
		added: '2026-11-03T10:00:00.000Z',
		files: [file('oc-media', 'My.Hero.Academia.S04E20.mkv', 2518403024)],
		filesLoaded: true,
		kind: 'cloud',
	},
	{
		id: 'dl:qa-seedbox',
		provider: 'dl',
		title: 'Debrid-Link · retry example',
		filename: 'The.Matrix.1999.1080p.mkv',
		hash: rdRow.hash,
		size: 6900000000,
		progress: 43,
		status: 'downloading',
		serviceStatus: 'downloading',
		added: '2026-11-02T08:00:00.000Z',
		files: [file('dl-media', 'The.Matrix.1999.1080p.mkv', 6900000000)],
		filesLoaded: true,
		kind: 'torrent',
	},
];

const clonedItems = () => items.map((item) => ({ ...item, files: item.files.map((entry) => ({ ...entry })) }));

const values = new Map<ProviderId, string>(PROVIDERS.map((provider) => [provider, `qa-${provider}-fixture-token`]));
const storage: CredentialStorage = {
	get: async (provider) => values.get(provider) ?? null,
	set: async (provider, token) => void values.set(provider, token),
	remove: async (provider) => void values.delete(provider),
};

let failDebridLinkOnce = true;
let currentItems = clonedItems();
const api = {
	validateCredential: async (provider: ProviderId) => ({ label: `QA ${PROVIDER_META[provider].label}` }),
	listLibrary: async (provider: ProviderId) => {
		await new Promise((resolve) => setTimeout(resolve, provider === 'tb' ? 120 : 35));
		if (provider === 'dl' && failDebridLinkOnce) {
			failDebridLinkOnce = false;
			throw new Error('QA fixture: Debrid-Link temporarily unavailable; retry to recover.');
		}
		return currentItems.filter((item) => item.provider === provider).map((item) => ({ ...item, files: item.files.map((entry) => ({ ...entry })) }));
	},
	getLibraryDetail: async (_provider: ProviderId, _token: string, itemId: string) => {
		const item = currentItems.find((entry) => entry.id === itemId);
		if (!item) throw new Error('QA fixture item not found.');
		return { ...item, files: item.files.map((entry) => ({ ...entry })), filesLoaded: true };
	},
	resolveFile: async (_provider: ProviderId, _token: string, item: LibraryItem, fileId: string) => `https://files.example.invalid/${encodeURIComponent(item.id)}/${encodeURIComponent(fileId)}`,
	addMagnet: async () => undefined,
	deleteLibraryItem: async (_provider: ProviderId, _token: string, itemId: string) => {
		currentItems = currentItems.filter((item) => item.id !== itemId);
	},
	selectRealDebridFiles: async () => undefined,
} as SessionApi;

const session = new LibrarySession(storage, api);

export default function QaEntry() {
	return <SafeAreaProvider><AppProvider session={session}><AppNavigation /></AppProvider></SafeAreaProvider>;
}

registerRootComponent(QaEntry);
