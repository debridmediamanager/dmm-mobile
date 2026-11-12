import type {
	LibraryFile,
	LibraryItem,
	ProviderFailure,
	ProviderId,
	ProviderTokens,
} from './model';
import {
	addMagnet,
	addTorrentFile,
	addWebDownload,
	findRealDebridUncached,
	reinsertItem,
	type AddOptions,
	type PickedFile,
	deleteLibraryItem,
	getLibraryDetail,
	listLibrary,
	resolveFile,
	selectRealDebridFiles,
	validateCredential,
} from './providerApi';
import { needsRenewal, parseCredential, renewCredential, serializeCredential, type StoredCredential } from './auth';
import type { CredentialStorage } from './storage';
import type { AddEntry } from './share';
import { browserStateApi, credentialsFromState, identitiesFor, mergeState, settingsFromState, stateFromApp, type BrowserState, type BrowserStateApi, type SyncIdentity } from './sync';
import { loadSettings, saveSetting, type SettingName } from './settings';
import { isDemoToken, withDemo } from './demo';
import { TraktAccount } from './trakt';
import { runBulk, type BulkResult } from './core';

export type { BulkResult };
import { secureCredentialStorage } from './storage';

export interface SessionApi {
	validateCredential: typeof validateCredential;
	listLibrary: typeof listLibrary;
	getLibraryDetail: typeof getLibraryDetail;
	resolveFile: typeof resolveFile;
	addMagnet: typeof addMagnet;
	deleteLibraryItem: typeof deleteLibraryItem;
	selectRealDebridFiles: typeof selectRealDebridFiles;
	renewCredential: typeof renewCredential;
	addTorrentFile: typeof addTorrentFile;
	addWebDownload: typeof addWebDownload;
	reinsertItem: typeof reinsertItem;
	findRealDebridUncached: typeof findRealDebridUncached;
}

export interface SessionSnapshot {
	connected: Record<ProviderId, boolean>;
	labels: Partial<Record<ProviderId, string>>;
	items: LibraryItem[];
	loading: Record<ProviderId, boolean>;
	failures: ProviderFailure[];
	/** When the oldest connected provider list was fetched, or undefined before any. */
	fetchedAt?: number;
	/** Whether Real-Debrid's uncached rows have been looked up (it takes 100-row pages). */
	rdUncachedChecked: boolean;
}

const LATE_LISTING_MS = 4000;

// The demo key (src/demo.ts) is answered locally; every other credential reaches its provider.
const defaultApi: SessionApi = withDemo({
	validateCredential,
	listLibrary,
	getLibraryDetail,
	resolveFile,
	addMagnet,
	deleteLibraryItem,
	selectRealDebridFiles,
	renewCredential,
	addTorrentFile,
	addWebDownload,
	reinsertItem,
	findRealDebridUncached,
});

const emptySnapshot = (): SessionSnapshot => ({
	connected: { rd: false, ad: false, tb: false, pm: false, oc: false, dl: false },
	labels: {},
	items: [],
	loading: { rd: false, ad: false, tb: false, pm: false, oc: false, dl: false },
	failures: [],
	rdUncachedChecked: false,
});

const messageOf = (error: unknown): string =>
	error instanceof Error ? error.message : 'The provider request failed.';

export class LibrarySession {
	private readonly storage: CredentialStorage;
	private readonly api: SessionApi;
	private readonly tokens: ProviderTokens = {};
	private readonly credentials: Partial<Record<ProviderId, StoredCredential>> = {};
	private readonly renewals = new Map<ProviderId, Promise<void>>();
	private readonly itemsByProvider: Partial<Record<ProviderId, LibraryItem[]>> = {};
	private readonly labels: Partial<Record<ProviderId, string>> = {};
	private readonly failures = new Map<ProviderId, ProviderFailure>();
	private readonly loading = new Set<ProviderId>();
	private readonly generations: Record<ProviderId, number> = {
		rd: 0,
		ad: 0,
		tb: 0,
		pm: 0,
		oc: 0,
		dl: 0,
	};
	private readonly controllers = new Map<ProviderId, AbortController>();
	private readonly fetchedAt: Partial<Record<ProviderId, number>> = {};
	private rdUncached: Set<string> | null = null;
	private readonly listeners = new Set<() => void>();
	private readonly connectionOperations: Record<ProviderId, number> = {
		rd: 0,
		ad: 0,
		tb: 0,
		pm: 0,
		oc: 0,
		dl: 0,
	};
	private readonly storageTails: Partial<Record<ProviderId, Promise<void>>> = {};

	private readonly sync: BrowserStateApi | null;
	/** The Trakt login, saved across devices with the others (none where nothing syncs: tests, the QA build). */
	readonly trakt: TraktAccount | null;
	/** Providers removed in the app since it started: their logins leave the saved state. */
	private readonly removedLogins = new Set<ProviderId>();
	private pushTimer: ReturnType<typeof setTimeout> | null = null;

	// Only the real providers sync with DMM unless a test or the QA build passes its own.
	constructor(storage: CredentialStorage = secureCredentialStorage, api: SessionApi = defaultApi, sync: BrowserStateApi | null = api === defaultApi ? browserStateApi : null) {
		this.storage = storage;
		this.api = api;
		this.sync = sync;
		// Saved at once after a renewal: Trakt's refresh tokens work once, and another device may be about to renew.
		this.trakt = sync ? new TraktAccount({ pull: () => this.pull(), changed: () => this.schedulePush(0) }) : null;
	}

	/** The demo key's library never reaches DMM or Trakt. */
	isDemo(provider: ProviderId): boolean {
		return isDemoToken(this.tokens[provider]);
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		for (const listener of this.listeners) listener();
	}

	private isCurrentConnection(provider: ProviderId, generation: number, operation: number): boolean {
		return this.generations[provider] === generation && this.connectionOperations[provider] === operation;
	}

	private enqueueStorage(provider: ProviderId, operation: () => Promise<void>): Promise<void> {
		const prior = this.storageTails[provider] ?? Promise.resolve();
		const next = prior.catch(() => undefined).then(operation);
		this.storageTails[provider] = next.catch(() => undefined);
		return next;
	}

	async loadCredentials(): Promise<void> {
		const reads = await Promise.all(
			(Object.keys(this.generations) as ProviderId[]).map(async (provider) => {
				const generation = this.generations[provider];
				const operation = this.connectionOperations[provider];
				return { provider, token: await this.storage.get(provider), generation, operation };
			})
		);
		for (const { provider, token, generation, operation } of reads) {
			if (generation !== this.generations[provider] || operation !== this.connectionOperations[provider]) continue;
			if (!token) continue;
			const credential = parseCredential(token);
			this.credentials[provider] = credential;
			this.tokens[provider] = credential.token;
			if (credential.label) this.labels[provider] = credential.label;
		}
		this.notify();
	}

	snapshot(): SessionSnapshot {
		const snapshot = emptySnapshot();
		for (const provider of Object.keys(this.generations) as ProviderId[]) {
			snapshot.connected[provider] = Boolean(this.tokens[provider]);
			snapshot.loading[provider] = this.loading.has(provider);
			if (this.labels[provider]) snapshot.labels[provider] = this.labels[provider];
		}
		snapshot.items = (Object.values(this.itemsByProvider) as LibraryItem[][]).flat();
		const times = (Object.keys(this.generations) as ProviderId[]).filter((provider) => this.tokens[provider]).map((provider) => this.fetchedAt[provider]);
		if (times.length > 0 && times.every((time) => time !== undefined)) snapshot.fetchedAt = Math.min(...(times as number[]));
		snapshot.failures = [...this.failures.values()];
		snapshot.rdUncachedChecked = this.rdUncached !== null;
		return snapshot;
	}

	/** Renews an OAuth access token shortly before it expires; one renewal per provider at a time. */
	private renewIfDue(provider: ProviderId): Promise<void> | null {
		const credential = this.credentials[provider];
		if (!credential || !needsRenewal(credential)) return null;
		const pending = this.renewals.get(provider);
		if (pending) return pending;
		const generation = this.generations[provider];
		const operation = this.connectionOperations[provider];
		const renewal = (async () => {
			const renewed = await this.api.renewCredential(provider, credential);
			if (!this.isCurrentConnection(provider, generation, operation)) return;
			await this.enqueueStorage(provider, () => this.storage.set(provider, serializeCredential(renewed)));
			if (!this.isCurrentConnection(provider, generation, operation)) return;
			this.credentials[provider] = renewed;
			this.tokens[provider] = renewed.token;
		})().finally(() => this.renewals.delete(provider));
		this.renewals.set(provider, renewal);
		return renewal;
	}

	/** Synchronous unless a renewal is due, so a disconnect cannot slip in between. */
	private async tokenFor(provider: ProviderId): Promise<string> {
		const renewal = this.renewIfDue(provider);
		if (renewal) await renewal;
		return this.currentToken(provider);
	}

	private currentToken(provider: ProviderId): string {
		const token = this.tokens[provider];
		if (!token) throw new Error('Connect this provider in Accounts first.');
		return token;
	}

	/** Takes a pasted key or a credential from a device sign-in. */
	/** A sign-in: also brings back the logins and settings saved behind it (DMM's remember across devices). */
	async connect(provider: ProviderId, input: string | StoredCredential): Promise<void> {
		await this.saveLogin(provider, input);
		void this.restoreAfterLogin(provider);
	}

	private async saveLogin(provider: ProviderId, input: string | StoredCredential): Promise<void> {
		const credential = typeof input === 'string' ? { token: input.trim() } : { ...input, token: input.token.trim() };
		const generation = this.generations[provider];
		const operation = ++this.connectionOperations[provider];
		const account = await this.api.validateCredential(provider, credential.token);
		if (!this.isCurrentConnection(provider, generation, operation)) throw new Error('Connection was cancelled.');
		if (account.label) credential.label = account.label;
		await this.enqueueStorage(provider, () => this.storage.set(provider, serializeCredential(credential)));
		if (!this.isCurrentConnection(provider, generation, operation)) throw new Error('Connection was cancelled.');
		this.credentials[provider] = credential;
		this.tokens[provider] = credential.token;
		if (account.label) this.labels[provider] = account.label;
		this.failures.delete(provider);
		this.removedLogins.delete(provider);
		this.notify();
	}

	async disconnect(provider: ProviderId): Promise<void> {
		this.removedLogins.add(provider);
		this.schedulePush();
		this.connectionOperations[provider] += 1;
		this.generations[provider] += 1;
		this.controllers.get(provider)?.abort();
		this.controllers.delete(provider);
		delete this.tokens[provider];
		delete this.credentials[provider];
		delete this.labels[provider];
		delete this.itemsByProvider[provider];
		delete this.fetchedAt[provider];
		if (provider === 'rd') this.rdUncached = null;
		this.failures.delete(provider);
		this.loading.delete(provider);
		this.notify();
		// Signed out of everything: whoever signs in next must not inherit this Trakt login.
		if (!Object.values(this.tokens).some(Boolean)) void this.trakt?.forget();
		try {
			await this.enqueueStorage(provider, () => this.storage.remove(provider));
		} catch (error) {
			this.failures.set(provider, { provider, message: `Secure credential removal failed: ${messageOf(error)}` });
			this.notify();
			throw error;
		}
	}

	/**
	 * After a sign-in, asks DMM for the state saved behind that login, connects the other
	 * providers it holds and adopts the settings this device has not set, then saves the
	 * merged state back. Failures stay quiet: the sign-in itself already worked.
	 */
	private async restoreAfterLogin(provider: ProviderId): Promise<void> {
		if (!this.sync) return;
		const credential = this.credentials[provider];
		const [identity] = credential ? identitiesFor({ [provider]: credential }) : [];
		if (!identity) return;
		try {
			const state = await this.sync.restore(identity);
			if (state) await this.adoptState(state);
		} catch {
			// DMM unreachable or the login refused there: nothing to bring back this time.
		}
		this.schedulePush();
	}

	/**
	 * Connects the logins a DMM web state holds that this device lacks and adopts the settings it has not set:
	 * a restore after a sign-in, or a TV linked from a phone (DMM's /tv pairing). Failing logins are skipped.
	 */
	async adoptState(state: BrowserState): Promise<ProviderId[]> {
		await this.trakt?.adopt(state);
		const restored = credentialsFromState(state);
		for (const other of Object.keys(restored) as ProviderId[]) this.removedLogins.delete(other);
		await Promise.all(
			(Object.keys(restored) as ProviderId[])
				// What DMM holds now wins over a removal made here earlier: another device saved it again.
				.filter((other) => !this.tokens[other])
				.map(async (other) => {
					try {
						let login = restored[other]!;
						if (needsRenewal(login) || !login.token) login = await this.api.renewCredential(other, login);
						await this.saveLogin(other, login);
						await this.refreshProvider(other);
					} catch {
						// A saved login that no longer works is left for the user to sign in again.
					}
				})
		);
		const local = await loadSettings();
		const remote = settingsFromState(state);
		for (const name of Object.keys(remote) as SettingName[]) {
			if (!local[name]) await saveSetting(name, remote[name]!);
		}
		return (Object.keys(restored) as ProviderId[]).filter((provider) => Boolean(this.tokens[provider]));
	}

	/** Saves this device's logins and settings behind every login it holds, a moment after the last change. */
	schedulePush(delayMs = 2000): void {
		if (!this.sync) return;
		if (this.pushTimer) clearTimeout(this.pushTimer);
		this.pushTimer = setTimeout(() => {
			this.pushTimer = null;
			void this.push().catch(() => undefined);
		}, delayMs);
	}

	/**
	 * The logins DMM may check before it names this library (its library identification), none
	 * where nothing syncs with DMM (the demo key, tests, the QA build). Real-Debrid's last: DMM
	 * checks a login from its own address, and Real-Debrid holds an account to one.
	 */
	titleIdentities(): SyncIdentity[] {
		if (!this.sync) return [];
		const identities = identitiesFor(this.credentials);
		return [...identities.filter((identity) => identity.service !== 'rd'), ...identities.filter((identity) => identity.service === 'rd')];
	}

	/** The app's logins and settings in DMM web's format, for a DMM page opened in the browser. */
	async browserState(): Promise<BrowserState> {
		return stateFromApp(this.credentials, await loadSettings());
	}

	/** DMM's saved state behind this device's logins, read fresh; null when nothing syncs or nothing is saved. */
	private async pull(): Promise<BrowserState | null> {
		const [identity] = this.titleIdentities();
		return identity && this.sync ? this.sync.restore(identity) : null;
	}

	private async push(): Promise<void> {
		const identities = identitiesFor(this.credentials);
		if (!this.sync || identities.length === 0) return;
		// Read fresh each time: another device may have saved since, and a cached copy would erase its changes.
		const remote = (await this.sync.restore(identities[0])) ?? {};
		// A Trakt login renewed or signed in elsewhere since is newer than ours: ours may be dead already.
		await this.trakt?.adopt(remote);
		const removed = this.trakt?.removed ? [...this.removedLogins, 'trakt' as const] : this.removedLogins;
		const state = mergeState(remote, { ...stateFromApp(this.credentials, await loadSettings()), ...this.trakt?.state() }, removed);
		await this.sync.save(identities, state);
		// Those logins are gone from DMM now; a later save must not erase them if another device adds them back.
		this.removedLogins.clear();
		if (this.trakt) this.trakt.removed = false;
	}

	async refreshProvider(provider: ProviderId): Promise<void> {
		if (!this.tokens[provider]) return;
		try {
			const renewal = this.renewIfDue(provider);
			if (renewal) await renewal;
		} catch (error) {
			this.failures.set(provider, { provider, message: messageOf(error) });
			this.notify();
			return;
		}
		const token = this.tokens[provider];
		if (!token) return;
		const generation = this.generations[provider];
		this.controllers.get(provider)?.abort();
		const controller = new AbortController();
		this.controllers.set(provider, controller);
		this.loading.add(provider);
		this.failures.delete(provider);
		this.notify();
		const isCurrent = () =>
			generation === this.generations[provider] &&
			this.tokens[provider] === token &&
			this.controllers.get(provider) === controller;
		try {
			const items = await this.api.listLibrary(provider, token, controller.signal);
			if (!isCurrent()) return;
			this.itemsByProvider[provider] = provider === 'rd' ? this.markRdUncached(items) : items;
			this.fetchedAt[provider] = Date.now();
			this.notify();
		} catch (error) {
			if (!isCurrent()) return;
			if (controller.signal.aborted) return;
			this.failures.set(provider, { provider, message: messageOf(error) });
			this.notify();
		} finally {
			if (this.controllers.get(provider) === controller) {
				this.controllers.delete(provider);
				this.loading.delete(provider);
				this.notify();
			}
		}
	}

	async refreshAll(): Promise<void> {
		await Promise.all(
			(Object.keys(this.generations) as ProviderId[])
				.filter((provider) => Boolean(this.tokens[provider]))
				.map((provider) => this.refreshProvider(provider))
		);
	}

	async detail(provider: ProviderId, itemId: string): Promise<LibraryItem> {
		const renewal = this.renewIfDue(provider);
		if (renewal) await renewal;
		const token = this.currentToken(provider);
		const generation = this.generations[provider];
		const item = await this.api.getLibraryDetail(provider, token, itemId);
		if (generation !== this.generations[provider] || this.tokens[provider] !== token) {
			throw new Error('Connection changed while loading this item.');
		}
		if (this.tokens[provider]) {
			const current = this.itemsByProvider[provider] ?? [];
			this.itemsByProvider[provider] = current.map((entry) => entry.id === item.id ? item : entry);
			this.notify();
		}
		return item;
	}

	async openFile(provider: ProviderId, item: LibraryItem, fileId: string): Promise<string> {
		const renewal = this.renewIfDue(provider);
		if (renewal) await renewal;
		const token = this.currentToken(provider);
		const generation = this.generations[provider];
		const url = await this.api.resolveFile(provider, token, item, fileId);
		if (generation !== this.generations[provider] || this.tokens[provider] !== token) {
			throw new Error('Connection changed while opening this file.');
		}
		return url;
	}

	async add(provider: ProviderId, magnet: string): Promise<void> {
		await this.api.addMagnet(provider, await this.tokenFor(provider), magnet);
		await this.refreshAfterAdd(provider);
	}

	/** TorBox lists a new torrent a few seconds after accepting it (2026-11-09), so look twice. */
	private async refreshAfterAdd(provider: ProviderId): Promise<void> {
		await this.refreshProvider(provider);
		setTimeout(() => void this.refreshProvider(provider), LATE_LISTING_MS);
	}

	/** Magnets, bare hashes and (TorBox) web links; the list refreshes once afterwards. */
	async addMany(provider: ProviderId, entries: readonly AddEntry[], options: AddOptions = {}, onProgress?: (finished: number, total: number) => void): Promise<BulkResult> {
		try {
			return await runBulk(
				entries,
				async (entry) => {
					const token = await this.tokenFor(provider);
					if (entry.kind === 'url') {
						if (provider !== 'tb') throw new Error('Only TorBox downloads web links.');
						await this.api.addWebDownload(token, entry.url);
					} else await this.api.addMagnet(provider, token, entry.kind === 'magnet' ? entry.magnet : entry.hash, undefined, options);
				},
				(entry) => (entry.kind === 'url' ? entry.url : entry.hash),
				onProgress,
				// RD answers parallel adds with a pause; DMM web paces it too.
				provider === 'rd' ? 1 : 4
			);
		} finally {
			await this.refreshAfterAdd(provider);
		}
	}

	async addFile(provider: ProviderId, file: PickedFile): Promise<void> {
		await this.api.addTorrentFile(provider, await this.tokenFor(provider), file);
		await this.refreshAfterAdd(provider);
	}

	async reinsert(item: LibraryItem, fileIds?: string[]): Promise<void> {
		await this.api.reinsertItem(await this.tokenFor(item.provider), item, fileIds);
		await this.refreshProvider(item.provider);
	}

	private markRdUncached(items: LibraryItem[]): LibraryItem[] {
		const ids = this.rdUncached;
		return ids ? items.map((item) => (Boolean(item.uncached) === ids.has(item.id) ? item : { ...item, uncached: ids.has(item.id) })) : items;
	}

	/** Looks up which Real-Debrid rows it no longer serves; the list's large pages cannot tell. */
	async checkRdUncached(onProgress?: (done: number, total: number) => void): Promise<void> {
		const generation = this.generations.rd;
		const ids = await this.api.findRealDebridUncached(await this.tokenFor('rd'), onProgress);
		if (generation !== this.generations.rd) return;
		this.rdUncached = ids;
		if (this.itemsByProvider.rd) this.itemsByProvider.rd = this.markRdUncached(this.itemsByProvider.rd);
		this.notify();
	}

	/** Deletes or reinserts many rows, then refreshes each touched provider once. */
	async bulk(action: 'delete' | 'reinsert', items: readonly LibraryItem[], onProgress?: (finished: number, total: number) => void): Promise<BulkResult> {
		try {
			return await runBulk(
				items,
				async (item) => {
					const token = await this.tokenFor(item.provider);
					if (action === 'delete') await this.api.deleteLibraryItem(item.provider, token, item.id);
					else await this.api.reinsertItem(token, item);
				},
				(item) => item.title,
				onProgress
			);
		} finally {
			await Promise.all([...new Set(items.map((item) => item.provider))].map((provider) => this.refreshProvider(provider)));
		}
	}

	async remove(provider: ProviderId, itemId: string): Promise<void> {
		await this.api.deleteLibraryItem(provider, await this.tokenFor(provider), itemId);
		await this.refreshProvider(provider);
	}

	async selectFiles(item: LibraryItem, files: LibraryFile[]): Promise<void> {
		if (item.provider !== 'rd') throw new Error('File selection is only available for Real-Debrid waiting items.');
		await this.api.selectRealDebridFiles(await this.tokenFor('rd'), item.id, files.map((file) => file.id));
		await this.refreshProvider('rd');
	}
}
