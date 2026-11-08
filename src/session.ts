import type {
	LibraryFile,
	LibraryItem,
	ProviderFailure,
	ProviderId,
	ProviderTokens,
} from './model';
import {
	addMagnet,
	deleteLibraryItem,
	getLibraryDetail,
	listLibrary,
	resolveFile,
	selectRealDebridFiles,
	validateCredential,
} from './providerApi';
import type { CredentialStorage } from './storage';
import { secureCredentialStorage } from './storage';

export interface SessionApi {
	validateCredential: typeof validateCredential;
	listLibrary: typeof listLibrary;
	getLibraryDetail: typeof getLibraryDetail;
	resolveFile: typeof resolveFile;
	addMagnet: typeof addMagnet;
	deleteLibraryItem: typeof deleteLibraryItem;
	selectRealDebridFiles: typeof selectRealDebridFiles;
}

export interface SessionSnapshot {
	connected: Record<ProviderId, boolean>;
	labels: Partial<Record<ProviderId, string>>;
	items: LibraryItem[];
	loading: Record<ProviderId, boolean>;
	failures: ProviderFailure[];
}

const defaultApi: SessionApi = {
	validateCredential,
	listLibrary,
	getLibraryDetail,
	resolveFile,
	addMagnet,
	deleteLibraryItem,
	selectRealDebridFiles,
};

const emptySnapshot = (): SessionSnapshot => ({
	connected: { rd: false, ad: false, tb: false, pm: false, oc: false, dl: false },
	labels: {},
	items: [],
	loading: { rd: false, ad: false, tb: false, pm: false, oc: false, dl: false },
	failures: [],
});

const messageOf = (error: unknown): string =>
	error instanceof Error ? error.message : 'The provider request failed.';

export class LibrarySession {
	private readonly storage: CredentialStorage;
	private readonly api: SessionApi;
	private readonly tokens: ProviderTokens = {};
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

	constructor(storage: CredentialStorage = secureCredentialStorage, api: SessionApi = defaultApi) {
		this.storage = storage;
		this.api = api;
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
			if (token) this.tokens[provider] = token;
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
		snapshot.failures = [...this.failures.values()];
		return snapshot;
	}

	private tokenFor(provider: ProviderId): string {
		const token = this.tokens[provider];
		if (!token) throw new Error('Connect this provider in Accounts first.');
		return token;
	}

	async connect(provider: ProviderId, token: string): Promise<void> {
		const cleanToken = token.trim();
		const generation = this.generations[provider];
		const operation = ++this.connectionOperations[provider];
		const account = await this.api.validateCredential(provider, cleanToken);
		if (!this.isCurrentConnection(provider, generation, operation)) throw new Error('Connection was cancelled.');
		await this.enqueueStorage(provider, () => this.storage.set(provider, cleanToken));
		if (!this.isCurrentConnection(provider, generation, operation)) throw new Error('Connection was cancelled.');
		this.tokens[provider] = cleanToken;
		if (account.label) this.labels[provider] = account.label;
		this.failures.delete(provider);
		this.notify();
	}

	async disconnect(provider: ProviderId): Promise<void> {
		this.connectionOperations[provider] += 1;
		this.generations[provider] += 1;
		this.controllers.get(provider)?.abort();
		this.controllers.delete(provider);
		delete this.tokens[provider];
		delete this.labels[provider];
		delete this.itemsByProvider[provider];
		this.failures.delete(provider);
		this.loading.delete(provider);
		this.notify();
		try {
			await this.enqueueStorage(provider, () => this.storage.remove(provider));
		} catch (error) {
			this.failures.set(provider, { provider, message: `Secure credential removal failed: ${messageOf(error)}` });
			this.notify();
			throw error;
		}
	}

	async refreshProvider(provider: ProviderId): Promise<void> {
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
			this.itemsByProvider[provider] = items;
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
		const token = this.tokenFor(provider);
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
		const token = this.tokenFor(provider);
		const generation = this.generations[provider];
		const url = await this.api.resolveFile(provider, token, item, fileId);
		if (generation !== this.generations[provider] || this.tokens[provider] !== token) {
			throw new Error('Connection changed while opening this file.');
		}
		return url;
	}

	async add(provider: ProviderId, magnet: string): Promise<void> {
		await this.api.addMagnet(provider, this.tokenFor(provider), magnet);
		await this.refreshProvider(provider);
	}

	async remove(provider: ProviderId, itemId: string): Promise<void> {
		await this.api.deleteLibraryItem(provider, this.tokenFor(provider), itemId);
		await this.refreshProvider(provider);
	}

	async selectFiles(item: LibraryItem, files: LibraryFile[]): Promise<void> {
		if (item.provider !== 'rd') throw new Error('File selection is only available for Real-Debrid waiting items.');
		await this.api.selectRealDebridFiles(this.tokenFor('rd'), item.id, files.map((file) => file.id));
		await this.refreshProvider('rd');
	}
}
