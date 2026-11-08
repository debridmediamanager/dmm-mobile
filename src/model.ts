export const PROVIDERS = ['rd', 'ad', 'tb', 'pm', 'oc', 'dl'] as const;

export type ProviderId = (typeof PROVIDERS)[number];
export type LibraryStatus = 'waiting' | 'downloading' | 'finished' | 'error';
export type SortMode = 'newest' | 'title' | 'size';

export interface ProviderMeta {
	id: ProviderId;
	label: string;
	credentialLabel: string;
	color: string;
}

export const PROVIDER_META: Record<ProviderId, ProviderMeta> = {
	rd: {
		id: 'rd',
		label: 'Real-Debrid',
		credentialLabel: 'API token',
		color: '#b5d496',
	},
	ad: {
		id: 'ad',
		label: 'AllDebrid',
		credentialLabel: 'API key',
		color: '#fbc730',
	},
	tb: {
		id: 'tb',
		label: 'TorBox',
		credentialLabel: 'API token',
		color: '#4f46e5',
	},
	pm: {
		id: 'pm',
		label: 'Premiumize',
		credentialLabel: 'API key',
		color: '#aa0000',
	},
	oc: {
		id: 'oc',
		label: 'Offcloud',
		credentialLabel: 'API key',
		color: '#f97316',
	},
	dl: {
		id: 'dl',
		label: 'Debrid-Link',
		credentialLabel: 'API token',
		color: '#38bdf8',
	},
};

export interface LibraryFile {
	id: string;
	name: string;
	size: number;
	/** A provider link is filled only by a user-triggered detail request. */
	link?: string;
	path?: string;
	selected?: boolean;
}

export interface LibraryItem {
	id: string;
	provider: ProviderId;
	title: string;
	filename: string;
	hash: string;
	size: number;
	progress: number;
	status: LibraryStatus;
	serviceStatus: string;
	added: string;
	files: LibraryFile[];
	/** True when the provider can expose a more complete detail row. */
	filesLoaded?: boolean;
	/** A waiting RD item can require an explicit file selection. */
	needsFileSelection?: boolean;
	kind?: 'torrent' | 'web' | 'usenet' | 'transfer' | 'folder' | 'file' | 'cloud';
}

export interface ProviderFailure {
	provider: ProviderId;
	message: string;
	code?: string;
}

export interface ProviderAccount {
	connected: boolean;
	label?: string;
}

export type ProviderTokens = Partial<Record<ProviderId, string>>;

export const statusLabel = (status: LibraryStatus): string =>
	status[0].toUpperCase() + status.slice(1);

export const providerFromItemId = (id: string): ProviderId | null => {
	const prefix = id.split(':', 1)[0];
	return PROVIDERS.includes(prefix as ProviderId) ? (prefix as ProviderId) : null;
};
