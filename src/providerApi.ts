import type {
	LibraryFile,
	LibraryItem,
	LibraryStatus,
	ProviderId,
} from './model';
import { displayName, isBtih, normalizePercent, safeDate, safeNumber } from './validation';

const RD_BASE = 'https://app.real-debrid.com/rest/1.0';
const AD_BASE = 'https://api.alldebrid.com/v4.1';
const TB_BASE = 'https://api.torbox.app/v1/api';
const PM_BASE = 'https://www.premiumize.me/api';
const OC_BASE = 'https://offcloud.com/api';
const DL_BASE = 'https://debrid-link.fr/api/v2';

const PAGE_SIZE = 1000;
const MAX_PAGES = 100;
const REQUEST_TIMEOUT_MS = 30_000;
const DL_FLOOD_LOCKOUT_MS = 60 * 60 * 1000;
const dlFloodLockouts = new Map<string, number>();

export class ProviderApiError extends Error {
	readonly provider: ProviderId;
	readonly code: string;
	readonly status?: number;

	constructor(provider: ProviderId, message: string, code = 'provider_error', status?: number) {
		super(message);
		this.name = 'ProviderApiError';
		this.provider = provider;
		this.code = code;
		this.status = status;
	}
}

export class PaginationLimitError extends ProviderApiError {
	constructor(provider: ProviderId) {
		super(
			provider,
			`The ${provider} library is larger than this app's safe pagination limit.`,
			'pagination_limit'
		);
		this.name = 'PaginationLimitError';
	}
}

interface HttpResult<T> {
	body: T;
	response: Response;
}

const errorText = (body: unknown, fallback: string): string => {
	if (body && typeof body === 'object') {
		const record = body as Record<string, unknown>;
		for (const key of ['message', 'detail', 'error_description', 'error']) {
			if (typeof record[key] === 'string' && record[key]) return record[key] as string;
		}
	}
	return fallback;
};

async function request<T>(
	provider: ProviderId,
	url: string,
	init: RequestInit = {},
	signal?: AbortSignal
): Promise<HttpResult<T>> {
	const dlEndpoint = provider === 'dl' ? debridLinkEndpointTemplate(url) : undefined;
	if (dlEndpoint) {
		const until = dlFloodLockouts.get(dlEndpoint);
		if (until && until > Date.now()) {
			throw new ProviderApiError(provider, `Debrid-Link rate-limited ${dlEndpoint}.`, 'floodDetected');
		}
		if (until) dlFloodLockouts.delete(dlEndpoint);
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	const abort = () => controller.abort();
	if (signal?.aborted) controller.abort();
	else signal?.addEventListener('abort', abort, { once: true });
	try {
		let response: Response;
		try {
			response = await fetch(url, { ...init, signal: controller.signal });
		} catch (error) {
			if (controller.signal.aborted) {
				if (signal?.aborted) throw error;
				throw new ProviderApiError(provider, 'The provider request timed out.', 'timeout');
			}
			throw new ProviderApiError(provider, 'The provider could not be reached.', 'network');
		}

		const raw = await response.text();
		let body: unknown = null;
		if (raw.trim()) {
			try {
				body = JSON.parse(raw);
			} catch {
				throw new ProviderApiError(
					provider,
					`The provider returned an unreadable response (${response.status}).`,
					'non_json_response',
					response.status
				);
			}
		}
		if (!response.ok) {
			if (dlEndpoint && isDebridLinkFloodEnvelope(body)) dlFloodLockouts.set(dlEndpoint, Date.now() + DL_FLOOD_LOCKOUT_MS);
			throw new ProviderApiError(
				provider,
				errorText(body, `The provider rejected the request (${response.status}).`),
				response.status === 401 || response.status === 403 ? 'bad_token' : `http_${response.status}`,
				response.status
			);
		}
		if (dlEndpoint && isDebridLinkFloodEnvelope(body)) dlFloodLockouts.set(dlEndpoint, Date.now() + DL_FLOOD_LOCKOUT_MS);
		return { body: body as T, response };
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener('abort', abort);
	}
}

const debridLinkEndpointTemplate = (url: string): string | undefined => {
	if (!url.startsWith(`${DL_BASE}/`)) return undefined;
	const path = url.slice(`${DL_BASE}/`.length).split('?', 1)[0];
	return path.replace(/^seedbox\/[^/]+\/remove$/, 'seedbox/:id/remove');
};

const isDebridLinkFloodEnvelope = (body: unknown): boolean =>
	Boolean(body && typeof body === 'object' && (body as Record<string, unknown>).error === 'floodDetected');

const authHeaders = (token: string): HeadersInit => ({ Authorization: `Bearer ${token}` });

const formBody = (values: Record<string, unknown>): string => {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(values)) {
		if (value === undefined || value === null) continue;
		if (Array.isArray(value)) value.forEach((entry) => params.append(key, String(entry)));
		else params.append(key, String(value));
	}
	return params.toString();
};

async function formRequest<T>(
	provider: ProviderId,
	url: string,
	token: string,
	values: Record<string, unknown>,
	signal?: AbortSignal
): Promise<HttpResult<T>> {
	return request<T>(
		provider,
		url,
		{
			method: 'POST',
			headers: { ...authHeaders(token), 'Content-Type': 'application/x-www-form-urlencoded' },
			body: formBody(values),
		},
		signal
	);
}

async function jsonRequest<T>(
	provider: ProviderId,
	url: string,
	token: string,
	body: unknown,
	signal?: AbortSignal
): Promise<HttpResult<T>> {
	return request<T>(
		provider,
		url,
		{
			method: 'POST',
			headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		},
		signal
	);
}

const assertObject = (value: unknown, provider: ProviderId): Record<string, unknown> => {
	if (!value || typeof value !== 'object') {
		throw new ProviderApiError(provider, 'The provider returned an invalid response.', 'invalid_response');
	}
	return value as Record<string, unknown>;
};

const assertAd = (value: unknown): Record<string, unknown> => {
	const body = assertObject(value, 'ad');
	if (body.status !== 'success') {
		throw new ProviderApiError('ad', errorText(body.error, 'AllDebrid rejected the request.'), 'provider_error');
	}
	return body;
};

const assertTorBox = (value: unknown): Record<string, unknown> => {
	const body = assertObject(value, 'tb');
	if (body.success !== true) {
		throw new ProviderApiError('tb', errorText(body, 'TorBox rejected the request.'), 'business_error');
	}
	return body;
};

const assertPremiumize = (value: unknown): Record<string, unknown> => {
	const body = assertObject(value, 'pm');
	if (body.status !== 'success') {
		throw new ProviderApiError('pm', errorText(body, 'Premiumize rejected the request.'), String(body.code ?? 'business_error'));
	}
	return body;
};

const assertOffcloud = (value: unknown): Record<string, unknown> => {
	const body = assertObject(value, 'oc');
	if (body.error) {
		throw new ProviderApiError('oc', errorText(body, 'Offcloud rejected the request.'), String(body.error));
	}
	return body;
};

const assertDebridLink = (value: unknown): Record<string, unknown> => {
	const body = assertObject(value, 'dl');
	if (body.success !== true) {
		throw new ProviderApiError('dl', errorText(body, 'Debrid-Link rejected the request.'), String(body.error ?? 'business_error'));
	}
	return body;
};

const asArray = <T>(value: unknown): T[] => {
	if (!value) return [];
	return Array.isArray(value) ? (value as T[]) : [value as T];
};

const optionalNumber = (value: unknown): number | undefined => {
	const numeric = typeof value === 'number' ? value : Number(value);
	return value === undefined || value === null || !Number.isFinite(numeric) ? undefined : numeric;
};

const clampStatus = (value: number): number => Math.max(0, Math.min(100, value));

const rdStatus = (value: unknown): LibraryStatus => {
	switch (String(value ?? '').toLowerCase()) {
		case 'magnet_conversion':
		case 'waiting_files_selection':
		case 'queued':
			return 'waiting';
		case 'downloading':
		case 'compressing':
		case 'uploading':
			return 'downloading';
		case 'downloaded':
			return 'finished';
		default:
			return 'error';
	}
};

const rdFiles = (row: Record<string, unknown>, includeLinks = true): LibraryFile[] => {
	const files = Array.isArray(row.files) ? row.files : [];
	const links = Array.isArray(row.links) ? row.links : [];
	const selectedCount = files.filter((file) => assertObject(file, 'rd').selected === 1 || assertObject(file, 'rd').selected === true).length;
	// Links map to selected files in order only when there is one each. Fewer links means
	// Real-Debrid packed the selection into an archive, and no file has a link of its own.
	const mapped = links.length === selectedCount;
	let selectedLinkIndex = 0;
	return files.map((file, index) => {
		const entry = assertObject(file, 'rd');
		const selected = entry.selected === 1 || entry.selected === true;
		const link = mapped && selected ? links[selectedLinkIndex++] : undefined;
		return {
			id: String(entry.id ?? index),
			name: displayName(entry.path, `File ${index + 1}`),
			size: safeNumber(entry.bytes),
			link: includeLinks && typeof link === 'string' ? normalizeRdLink(link) : undefined,
			selected,
		};
	});
};

const normalizeRdLink = (link: string): string => {
	try {
		const url = new URL(link);
		if (url.pathname.startsWith('/d/')) {
			const id = url.pathname.slice(3).split('/', 1)[0];
			if (/^[A-Za-z0-9]{13,}$/.test(id)) return `${url.origin}/d/${id.slice(0, 13)}`;
		}
	} catch {
		// Preserve a provider link exactly when it is not a URL we can normalize.
	}
	return link;
};

const normalizeRd = (row: Record<string, unknown>, files: LibraryFile[] = []): LibraryItem => {
	const filename = displayName(row.original_filename ?? row.filename ?? row.hash);
	const status = rdStatus(row.status);
	return {
		id: `rd:${String(row.id)}`,
		provider: 'rd',
		title: filename,
		filename,
		hash: typeof row.hash === 'string' ? row.hash.toLowerCase() : '',
		size: safeNumber(row.bytes),
		progress: status === 'finished' ? 100 : clampStatus(safeNumber(row.progress)),
		status,
		serviceStatus: String(row.status ?? 'unknown'),
		added: safeDate(row.added),
		files,
		filesLoaded: files.length > 0,
		needsFileSelection: row.status === 'waiting_files_selection',
		kind: 'torrent',
		seeders: optionalNumber(row.seeders),
		speed: optionalNumber(row.speed),
		reinsertable: true,
		uncached: status === 'finished' && Array.isArray(row.links) && row.links.length === 0,
	};

};

const adStatus = (row: Record<string, unknown>): LibraryStatus => {
	const code = Number(row.statusCode);
	if (code === 0) return 'waiting';
	if (code >= 1 && code <= 3) return 'downloading';
	if (code === 4) return 'finished';
	return 'error';
};

const flattenAdFiles = (files: unknown[], parent = '', includeLinks = true): LibraryFile[] => {
	const result: LibraryFile[] = [];
	for (const raw of files) {
		const file = assertObject(raw, 'ad');
		const name = displayName(file.n, 'Unnamed file');
		const path = parent ? `${parent}/${name}` : name;
		if (Array.isArray(file.e)) result.push(...flattenAdFiles(file.e, path, includeLinks));
		else {
			result.push({
				id: path,
				name: path,
				size: safeNumber(file.s),
				link: includeLinks && typeof file.l === 'string' ? file.l : undefined,
			});
		}
	}
	return result;
};

const adFilesFromRow = (row: Record<string, unknown>, includeLinks = true): LibraryFile[] => {
	if (Array.isArray(row.files)) return flattenAdFiles(row.files, '', includeLinks);
	if (!Array.isArray(row.links)) return [];
	return row.links.map((raw, index) => {
		const link = assertObject(raw, 'ad');
		return {
			id: String(index),
			name: displayName(link.filename, `File ${index + 1}`),
			size: safeNumber(link.size),
			link: includeLinks && typeof link.link === 'string' ? link.link : undefined,
		};
	});
};

const normalizeAd = (row: Record<string, unknown>, files = adFilesFromRow(row)): LibraryItem => {
	const filename = displayName(row.filename ?? row.hash);
	const status = adStatus(row);
	const uploaded = safeNumber(row.uploadDate);
	return {
		id: `ad:${String(row.id)}`,
		provider: 'ad',
		title: filename,
		filename,
		hash: typeof row.hash === 'string' ? row.hash.toLowerCase() : '',
		size: safeNumber(row.size),
		progress: status === 'finished' ? 100 : normalizePercent(row.downloaded && row.size ? Number(row.downloaded) / Number(row.size) : row.processingPerc),
		status,
		serviceStatus: String(row.status ?? row.statusCode ?? 'unknown'),
		added: safeDate(uploaded ? uploaded * 1000 : 0),
		files,
		filesLoaded: files.length > 0,
		kind: 'torrent',
		seeders: optionalNumber(row.seeders),
		speed: optionalNumber(row.downloadSpeed),
		// AllDebrid statusCode 5 and up are failures, the only ones magnet/restart accepts.
		reinsertable: Number(row.statusCode) >= 5,
		uncached: Number(row.statusCode) === 11,
	};
};

const torboxStatus = (row: Record<string, unknown>): LibraryStatus => {
	if (row.download_finished === true && row.download_present === true) return 'finished';
	if (row.download_finished === true) return 'error';
	switch (String(row.download_state ?? '').toLowerCase()) {
		case 'queued':
		case 'checking':
			return 'waiting';
		case 'downloading':
		case 'uploading':
			return 'downloading';
		default:
			return 'error';
	}
};

const torboxFiles = (row: Record<string, unknown>): LibraryFile[] =>
	(Array.isArray(row.files) ? row.files : []).map((raw, index) => {
		const file = assertObject(raw, 'tb');
		return {
			id: String(file.id ?? index),
			name: displayName(file.name, `File ${index + 1}`),
			size: safeNumber(file.size ?? file.bytes),
			path: typeof file.path === 'string' ? file.path : undefined,
		};
	});

const normalizeTorBox = (
	row: Record<string, unknown>,
	kind: 'torrent' | 'web' | 'usenet'
): LibraryItem => {
	const status = torboxStatus(row);
	const id = String(row.id);
	const filename = displayName(row.name ?? row.hash ?? id);
	return {
		id: `tb:${kind === 'web' ? 'w:' : kind === 'usenet' ? 'u:' : ''}${id}`,
		provider: 'tb',
		title: filename,
		filename,
		hash: typeof row.hash === 'string' ? row.hash.toLowerCase() : '',
		size: safeNumber(row.size ?? row.original_size),
		progress: status === 'finished' ? 100 : normalizePercent(row.progress),
		status,
		serviceStatus: String(row.download_state ?? 'unknown'),
		added: safeDate(row.created_at),
		files: torboxFiles(row),
		filesLoaded: Array.isArray(row.files),
		kind,
		seeders: optionalNumber(row.seeds),
		speed: optionalNumber(row.download_speed),
		// TorBox answers a reannounce of any finished torrent with DOWNLOAD_SERVER_ERROR.
		reinsertable: kind === 'torrent' && row.active === true,
	};
};

type PremiumizeTransfer = {
	id: string;
	name: string;
	status?: string;
	progress?: number | null;
	folder_id?: string | null;
	file_id?: string | null;
};

type PremiumizeEntry = {
	id: string;
	name: string;
	type: 'file' | 'folder';
	created_at?: number;
	size?: number;
	path?: string;
	link?: string | null;
	directlink?: string | null;
	stream_link?: string | null;
};

const pmStatus = (value: unknown): LibraryStatus => {
	switch (String(value ?? '').toLowerCase()) {
		case 'queued':
			return 'waiting';
		case 'running':
			return 'downloading';
		case 'finished':
		case 'seeding':
			return 'finished';
		default:
			return value ? 'error' : 'finished';
	}
};

const pmFiles = (entries: PremiumizeEntry[]): LibraryFile[] =>
	entries.map((entry, index) => ({
		id: entry.id || String(index),
		name: displayName(entry.name, `File ${index + 1}`),
		size: safeNumber(entry.size),
		path: entry.path,
	}));

const clampPercent = (value: unknown): number => {
	const numeric = typeof value === 'number' ? value : Number(value);
	return Number.isFinite(numeric) ? Math.max(0, Math.min(100, numeric)) : 0;
};

const makePmItem = (
	id: string,
	kind: LibraryItem['kind'],
	name: string,
	entries: PremiumizeEntry[],
	status: LibraryStatus,
	serviceStatus: string,
	added: unknown,
	hash = '',
	progress = status === 'finished' ? 100 : 0
): LibraryItem => ({
	id,
	provider: 'pm',
	title: displayName(name),
	filename: displayName(name),
	hash,
	size: entries.reduce((sum, entry) => sum + safeNumber(entry.size), 0),
	progress: clampPercent(progress),
	status,
	serviceStatus,
	added: safeDate(added),
	files: pmFiles(entries),
	filesLoaded: true,
	kind,
});

const buildPremiumizeItems = (
	transfers: PremiumizeTransfer[],
	root: PremiumizeEntry[],
	allFiles: PremiumizeEntry[]
): LibraryItem[] => {
	const usedRootIds = new Set<string>();
	const filesUnder = (name: string): PremiumizeEntry[] => {
		const prefix = `${name}/`;
		return allFiles.filter((entry) => entry.path === name || entry.path?.startsWith(prefix));
	};
	const transferItems = transfers.map((transfer) => {
		const linkedRoot = root.find(
			(entry) => entry.id === transfer.folder_id || entry.id === transfer.file_id
		);
		if (linkedRoot) usedRootIds.add(linkedRoot.id);
		const name = transfer.name || linkedRoot?.name || transfer.id;
		const entries = linkedRoot?.type === 'folder' ? filesUnder(linkedRoot.name) : linkedRoot ? [linkedRoot] : filesUnder(name);
		const progress = normalizePercent(transfer.progress ?? 0);
		const status = pmStatus(transfer.status);
		const createdAt = entries
			.map((entry) => safeNumber(entry.created_at, -1))
			.filter((value) => value >= 0)
			.sort((a, b) => a - b)[0];
		return makePmItem(
			`pm:t:${transfer.id}`,
			'transfer',
			name,
			entries,
			status,
			transfer.status ?? 'stored',
				createdAt === undefined ? undefined : createdAt * 1000,
			'',
			progress
		);
	});

	const cloudItems = root
		.filter((entry) => !usedRootIds.has(entry.id))
		.map((entry) =>
			makePmItem(
				`pm:${entry.type === 'folder' ? 'f' : 'i'}:${entry.id}`,
				entry.type === 'folder' ? 'folder' : 'file',
				entry.name,
				entry.type === 'folder' ? filesUnder(entry.name) : [entry],
				'finished',
				'stored',
				entry.created_at ? entry.created_at * 1000 : 0
			)
		);
	return [...transferItems, ...cloudItems];
};

type OffcloudHistory = {
	requestId: string;
	fileName: string;
	status: string;
	originalLink?: string;
	createdOn?: string;
};

const offcloudStatus = (value: unknown): LibraryStatus => {
	switch (String(value ?? '').toLowerCase()) {
		case 'created':
		case 'queued':
			return 'waiting';
		case 'downloading':
			return 'downloading';
		case 'downloaded':
			return 'finished';
		default:
			return 'error';
	}
};

const basename = (link: string): string => {
	try {
		const value = new URL(link).pathname.split('/').filter(Boolean).pop() ?? link;
		return decodeURIComponent(value);
	} catch {
		return link.split('?')[0].split('/').pop() || 'File';
	}
};

const normalizeOffcloud = (row: OffcloudHistory, files: LibraryFile[] = []): LibraryItem => {
	const filename = displayName(row.fileName);
	const hashMatch = row.originalLink?.match(/urn:btih:([a-z0-9]{32,40})/i);
	const status = offcloudStatus(row.status);
	return {
		id: `oc:${row.requestId}`,
		provider: 'oc',
		title: filename,
		filename,
		hash: hashMatch?.[1]?.toLowerCase() ?? '',
		size: files.reduce((sum, file) => sum + file.size, 0),
		progress: status === 'finished' ? 100 : 0,
		status,
		serviceStatus: row.status,
		added: safeDate(row.createdOn),
		files,
		filesLoaded: files.length > 0,
		kind: 'cloud',
	};
};

type DebridLinkFile = {
	id: string;
	name: string;
	size: number;
	downloadUrl?: string;
	downloadPercent?: number;
};

type DebridLinkTorrent = {
	id: string;
	name: string;
	created: number;
	hashString: string;
	status: number;
	totalSize: number;
	downloadPercent: number;
	downloadSpeed?: number;
	peersConnected?: number;
	isZip?: boolean;
	wait?: boolean;
	files?: DebridLinkFile[];
};

const dlStatus = (row: DebridLinkTorrent): LibraryStatus => {
	if (row.status >= 100) return 'finished';
	if (row.wait || row.status <= 2) return 'waiting';
	if (row.status === 4 || row.status === 6 || row.status === 8) return 'downloading';
	return 'error';
};

const dlFiles = (rows: DebridLinkFile[] | undefined): LibraryFile[] =>
	(Array.isArray(rows) ? rows : []).map((file, index) => ({
		id: String(file.id ?? index),
		name: displayName(file.name, `File ${index + 1}`),
		size: safeNumber(file.size),
	}));

const normalizeDebridLink = (row: DebridLinkTorrent): LibraryItem => {
	const files = dlFiles(row.files);
	const status = dlStatus(row);
	return {
		id: `dl:${row.id}`,
		provider: 'dl',
		title: displayName(row.name),
		filename: displayName(row.name),
		hash: displayName(row.hashString, '').toLowerCase(),
		size: safeNumber(row.totalSize),
		progress: status === 'finished' ? 100 : clampStatus(safeNumber(row.downloadPercent)),
		status,
		serviceStatus: String(row.status),
		added: safeDate(safeNumber(row.created) * 1000),
		files,
		filesLoaded: files.length > 0,
		kind: 'torrent',
		seeders: row.peersConnected,
		speed: row.downloadSpeed,
	};
};

async function listRealDebrid(token: string, signal?: AbortSignal): Promise<LibraryItem[]> {
	const items: LibraryItem[] = [];
	for (let page = 1; page <= MAX_PAGES; page++) {
		const result = await request<unknown>(
			'rd',
			`${RD_BASE}/torrents?page=${page}&limit=${PAGE_SIZE}&_fresh=${Date.now()}`,
			{ headers: authHeaders(token) },
			signal
		);
		if (!Array.isArray(result.body)) {
			throw new ProviderApiError('rd', 'Real-Debrid returned an invalid library list.', 'invalid_response');
		}
		const rows = result.body;
		items.push(...rows.map((row) => normalizeRd(assertObject(row, 'rd'))));
		const header = result.response.headers.get('x-total-count');
		const total = header ? Number(header) : NaN;
		if (rows.length === 0 || (Number.isFinite(total) && items.length >= total) || (!Number.isFinite(total) && rows.length < PAGE_SIZE)) return items;
	}
	throw new PaginationLimitError('rd');
}

async function listAllDebrid(token: string, signal?: AbortSignal): Promise<LibraryItem[]> {
	const result = await formRequest<{ status?: string; data?: unknown }>(
		'ad',
		`${AD_BASE}/magnet/status`,
		token,
		{ _fresh: Date.now() },
		signal
	);
	const body = assertAd(result.body);
	const data = assertObject(body.data, 'ad');
	return asArray<Record<string, unknown>>(data.magnets).map((row) => normalizeAd(row, adFilesFromRow(row, false)));
}

async function listTorBoxEndpoint(
	token: string,
	path: string,
	signal?: AbortSignal
): Promise<Record<string, unknown>[]> {
	const rows: Record<string, unknown>[] = [];
	for (let page = 0; page < MAX_PAGES; page++) {
		const offset = page * PAGE_SIZE;
		const result = await request<unknown>(
			'tb',
			`${TB_BASE}/${path}?offset=${offset}&limit=${PAGE_SIZE}&bypass_cache=true&_fresh=${Date.now()}`,
			{ headers: authHeaders(token) },
			signal
		);
		const body = assertTorBox(result.body);
		const pageRows = asArray<Record<string, unknown>>(body.data);
		rows.push(...pageRows);
		if (pageRows.length < PAGE_SIZE) return rows;
	}
	throw new PaginationLimitError('tb');
}

async function listTorBox(token: string, signal?: AbortSignal): Promise<LibraryItem[]> {
	const responses = await Promise.allSettled([
		listTorBoxEndpoint(token, 'torrents/mylist', signal),
		listTorBoxEndpoint(token, 'webdl/mylist', signal),
		listTorBoxEndpoint(token, 'usenet/mylist', signal),
	]);
	const successful = responses.filter(
		(result): result is PromiseFulfilledResult<Record<string, unknown>[]> => result.status === 'fulfilled'
	);
	if (successful.length !== responses.length) {
		const failed = responses.find((result): result is PromiseRejectedResult => result.status === 'rejected');
		throw failed?.reason ?? new ProviderApiError('tb', 'TorBox returned incomplete library data.');
	}
	const torrents = responses[0].status === 'fulfilled' ? responses[0].value : [];
	const webDownloads = responses[1].status === 'fulfilled' ? responses[1].value : [];
	const usenetDownloads = responses[2].status === 'fulfilled' ? responses[2].value : [];
	return [
		...torrents.map((row) => normalizeTorBox(row, 'torrent')),
		...webDownloads.map((row) => normalizeTorBox(row, 'web')),
		...usenetDownloads.map((row) => normalizeTorBox(row, 'usenet')),
	];
}

async function listPremiumize(token: string, signal?: AbortSignal): Promise<LibraryItem[]> {
	const [transferResult, rootResult, filesResult] = await Promise.all([
		formRequest<{ status?: string; transfers?: PremiumizeTransfer[] }>('pm', `${PM_BASE}/transfer/list`, token, {}, signal),
		formRequest<{ status?: string; content?: PremiumizeEntry[] }>('pm', `${PM_BASE}/folder/list`, token, {}, signal),
		formRequest<{ status?: string; files?: PremiumizeEntry[] }>('pm', `${PM_BASE}/item/listall`, token, {}, signal),
	]);
	const transfersBody = assertPremiumize(transferResult.body);
	const rootBody = assertPremiumize(rootResult.body);
	const filesBody = assertPremiumize(filesResult.body);
	return buildPremiumizeItems(
		asArray<PremiumizeTransfer>(transfersBody.transfers).filter((entry) => entry && typeof entry.id === 'string'),
		asArray<PremiumizeEntry>(rootBody.content),
		asArray<PremiumizeEntry>(filesBody.files)
	);
}

async function listOffcloud(token: string, signal?: AbortSignal): Promise<LibraryItem[]> {
	const result = await request<unknown>(
		'oc',
		`${OC_BASE}/cloud/history`,
		{ headers: authHeaders(token) },
		signal
	);
	const body = assertOffcloud(result.body);
	const entries = Array.isArray(body) ? body : [];
	return entries.map((entry) => normalizeOffcloud(assertObject(entry, 'oc') as unknown as OffcloudHistory));
}

async function listDebridLink(token: string, signal?: AbortSignal): Promise<LibraryItem[]> {
	const items: LibraryItem[] = [];
	for (let page = 0; page < MAX_PAGES; page++) {
		const result = await request<unknown>(
			'dl',
			`${DL_BASE}/seedbox/list?page=${page}&perPage=100`,
			{ headers: authHeaders(token) },
			signal
		);
		const body = assertDebridLink(result.body);
		const rows = asArray<Record<string, unknown>>(body.value);
		items.push(
			...rows.map((row) =>
				normalizeDebridLink({
					id: String(row.id ?? ''),
					name: displayName(row.name),
					created: safeNumber(row.created),
					hashString: displayName(row.hashString, ''),
					status: safeNumber(row.status),
					totalSize: safeNumber(row.totalSize),
					downloadPercent: safeNumber(row.downloadPercent),
					downloadSpeed: safeNumber(row.downloadSpeed),
					peersConnected: safeNumber(row.peersConnected),
					isZip: row.isZip === true,
					wait: row.wait === true,
					files: Array.isArray(row.files) ? (row.files as DebridLinkFile[]) : [],
				})
			)
		);
		const pagination = body.pagination && typeof body.pagination === 'object' ? (body.pagination as Record<string, unknown>) : null;
		const next = pagination?.next;
		if (next === -1) return items;
		if (typeof next === 'number' && next > page) {
			page = next - 1;
			continue;
		}
		if (next === undefined && rows.length < 100) return items;
		throw new ProviderApiError('dl', 'Debrid-Link returned a non-advancing page cursor.', 'pagination');
	}
	throw new PaginationLimitError('dl');
}

export async function listLibrary(
	provider: ProviderId,
	token: string,
	signal?: AbortSignal
): Promise<LibraryItem[]> {
	if (!token.trim()) throw new ProviderApiError(provider, 'Missing provider credential.', 'bad_token');
	switch (provider) {
		case 'rd':
			return listRealDebrid(token, signal);
		case 'ad':
			return listAllDebrid(token, signal);
		case 'tb':
			return listTorBox(token, signal);
		case 'pm':
			return listPremiumize(token, signal);
		case 'oc':
			return listOffcloud(token, signal);
		case 'dl':
			return listDebridLink(token, signal);
	}
}

export async function validateCredential(
	provider: ProviderId,
	token: string,
	signal?: AbortSignal
): Promise<{ label?: string }> {
	if (!token.trim()) throw new ProviderApiError(provider, 'Enter an API key or token.', 'bad_token');
	switch (provider) {
		case 'rd': {
			const result = await request<Record<string, unknown>>('rd', `${RD_BASE}/user`, { headers: authHeaders(token) }, signal);
			return { label: typeof result.body.username === 'string' ? result.body.username : undefined };
		}
		case 'ad': {
			const result = await request<Record<string, unknown>>('ad', `${AD_BASE}/user`, { headers: authHeaders(token) }, signal);
			const body = assertAd(result.body);
			const user = assertObject(body.data, 'ad').user;
			return { label: typeof (user as Record<string, unknown>)?.email === 'string' ? String((user as Record<string, unknown>).email) : undefined };
		}
		case 'tb': {
			const result = await request<unknown>('tb', `${TB_BASE}/user/me`, { headers: authHeaders(token) }, signal);
			const body = assertTorBox(result.body);
			const user = assertObject(body.data, 'tb');
			// TorBox plans: 0 Free, 1 Essential, 2 Pro, 3 Standard. Free has no API access.
			if (user.plan === 0) throw new ProviderApiError('tb', 'This TorBox account is on the free plan, which has no API access. A paid plan is needed.', 'not_premium');
			return { label: typeof user.email === 'string' ? user.email : undefined };
		}
		case 'pm': {
			const result = await formRequest<Record<string, unknown>>('pm', `${PM_BASE}/account/info`, token, {}, signal);
			const body = assertPremiumize(result.body);
			if (!(typeof body.premium_until === 'number' && body.premium_until * 1000 > Date.now())) {
				throw new ProviderApiError('pm', 'That sign-in works, but the Premiumize account is not premium.', 'not_premium');
			}
			return { label: body.customer_id === undefined ? undefined : String(body.customer_id) };
		}
		case 'oc': {
			const result = await request<Record<string, unknown>>('oc', `${OC_BASE}/account/info`, { headers: authHeaders(token) }, signal);
			const body = assertOffcloud(result.body);
			if (body.is_premium !== true) throw new ProviderApiError('oc', 'That key works, but the Offcloud account is not premium.', 'not_premium');
			return { label: typeof body.email === 'string' ? body.email : undefined };
		}
		case 'dl': {
			const result = await request<unknown>('dl', `${DL_BASE}/account/infos`, { headers: authHeaders(token) }, signal);
			const body = assertDebridLink(result.body);
			const account = assertObject(body.value, 'dl');
			if (account.accountType !== 1) throw new ProviderApiError('dl', 'That sign-in works, but the Debrid-Link account is not premium.', 'not_premium');
			return { label: typeof account.username === 'string' ? account.username : undefined };
		}
	}
}

const rawId = (itemId: string, prefix: string): string => {
	const value = itemId.startsWith(`${prefix}:`) ? itemId.slice(prefix.length + 1) : itemId;
	return value;
};

async function detailRealDebrid(token: string, itemId: string, signal?: AbortSignal): Promise<LibraryItem> {
	const result = await request<Record<string, unknown>>(
		'rd',
		`${RD_BASE}/torrents/info/${encodeURIComponent(rawId(itemId, 'rd'))}`,
		{ headers: authHeaders(token) },
		signal
	);
	return normalizeRd(result.body, rdFiles(result.body, false));
}

async function detailAllDebrid(token: string, itemId: string, signal?: AbortSignal): Promise<LibraryItem> {
	const id = rawId(itemId, 'ad');
	const result = await formRequest<{ status?: string; data?: unknown }>('ad', `${AD_BASE}/magnet/status`, token, { id }, signal);
	const body = assertAd(result.body);
	const data = assertObject(body.data, 'ad');
	const row = assertObject(asArray(data.magnets)[0], 'ad');
	if (!Array.isArray(row.files)) {
		const filesResult = await formRequest<{ status?: string; data?: unknown }>('ad', `${AD_BASE}/magnet/files`, token, { 'id[]': id }, signal);
		const filesBody = assertAd(filesResult.body);
		const filesData = assertObject(filesBody.data, 'ad');
		const magnet = assertObject(asArray(filesData.magnets)[0], 'ad');
		if (Array.isArray(magnet.files)) row.files = magnet.files;
	}
	return normalizeAd(row, adFilesFromRow(row, false));
}

const torboxDetailPath = (itemId: string): { path: string; kind: 'torrent' | 'web' | 'usenet'; id: string } => {
	if (itemId.startsWith('tb:w:')) return { path: 'webdl/mylist', kind: 'web', id: itemId.slice(5) };
	if (itemId.startsWith('tb:u:')) return { path: 'usenet/mylist', kind: 'usenet', id: itemId.slice(5) };
	return { path: 'torrents/mylist', kind: 'torrent', id: itemId.slice(3) };
};

async function detailTorBox(token: string, itemId: string, signal?: AbortSignal): Promise<LibraryItem> {
	const detail = torboxDetailPath(itemId);
	const result = await request<unknown>(
		'tb',
		`${TB_BASE}/${detail.path}?id=${encodeURIComponent(detail.id)}&bypass_cache=true&_fresh=${Date.now()}`,
		{ headers: authHeaders(token) },
		signal
	);
	const body = assertTorBox(result.body);
	const row = assertObject(asArray(body.data)[0], 'tb');
	if (String(row.id) !== detail.id) throw new ProviderApiError('tb', 'TorBox did not return the requested item.', 'not_found');
	return normalizeTorBox(row, detail.kind);
}

async function detailPremiumize(token: string, itemId: string, signal?: AbortSignal): Promise<LibraryItem> {
	const [transfersResult, rootResult, filesResult] = await Promise.all([
		formRequest<Record<string, unknown>>('pm', `${PM_BASE}/transfer/list`, token, {}, signal),
		formRequest<Record<string, unknown>>('pm', `${PM_BASE}/folder/list`, token, {}, signal),
		formRequest<Record<string, unknown>>('pm', `${PM_BASE}/item/listall`, token, {}, signal),
	]);
	const transfers = asArray<PremiumizeTransfer>(assertPremiumize(transfersResult.body).transfers);
	const root = asArray<PremiumizeEntry>(assertPremiumize(rootResult.body).content);
	const files = asArray<PremiumizeEntry>(assertPremiumize(filesResult.body).files);
	const item = buildPremiumizeItems(transfers, root, files).find((entry) => entry.id === itemId);
	if (!item) throw new ProviderApiError('pm', 'Premiumize did not return the requested item.', 'not_found');
	return item;
}

async function detailOffcloud(token: string, itemId: string, signal?: AbortSignal): Promise<LibraryItem> {
	const requestId = rawId(itemId, 'oc');
	const historyResult = await request<unknown>('oc', `${OC_BASE}/cloud/history`, { headers: authHeaders(token) }, signal);
	const historyBody = assertOffcloud(historyResult.body);
	const history = Array.isArray(historyBody) ? historyBody : [];
	const row = history.find((entry) => String((entry as Record<string, unknown>)?.requestId) === requestId) as OffcloudHistory | undefined;
	if (!row) throw new ProviderApiError('oc', 'Offcloud did not return the requested item.', 'not_found');
	const statusResult = await jsonRequest<{ status?: Record<string, unknown> }>('oc', `${OC_BASE}/cloud/status`, token, { requestId }, signal);
	const statusBody = assertOffcloud(statusResult.body);
	const status = assertObject(statusBody.status, 'oc');
	const merged = { ...row, status: String(status.status ?? row.status) } as OffcloudHistory;
	const exploreResult = await request<unknown>('oc', `${OC_BASE}/cloud/explore/${encodeURIComponent(requestId)}`, { headers: authHeaders(token) }, signal);
	const exploreBody = assertOffcloud(exploreResult.body);
	const links = Array.isArray(exploreBody) ? exploreBody.filter((link): link is string => typeof link === 'string') : [];
	return normalizeOffcloud(
		merged,
		links.map((link, index) => ({ id: String(index), name: basename(link), size: 0 }))
	);
}

async function detailDebridLink(token: string, itemId: string, signal?: AbortSignal): Promise<LibraryItem> {
	const id = rawId(itemId, 'dl');
	const result = await request<unknown>(
		'dl',
		`${DL_BASE}/seedbox/list?page=0&perPage=100&id=${encodeURIComponent(id)}&ids=${encodeURIComponent(id)}`,
		{ headers: authHeaders(token) },
		signal
	);
	const body = assertDebridLink(result.body);
	const row = asArray<Record<string, unknown>>(body.value).find((entry) => String(entry.id) === id);
	if (!row) throw new ProviderApiError('dl', 'Debrid-Link did not return the requested item.', 'not_found');
	return normalizeDebridLink({
		id,
		name: displayName(row.name),
		created: safeNumber(row.created),
		hashString: displayName(row.hashString, ''),
		status: safeNumber(row.status),
		totalSize: safeNumber(row.totalSize),
		downloadPercent: safeNumber(row.downloadPercent),
		downloadSpeed: safeNumber(row.downloadSpeed),
		peersConnected: safeNumber(row.peersConnected),
		isZip: row.isZip === true,
		wait: row.wait === true,
		files: Array.isArray(row.files) ? (row.files as DebridLinkFile[]) : [],
	});
}

export async function getLibraryDetail(
	provider: ProviderId,
	token: string,
	itemId: string,
	signal?: AbortSignal
): Promise<LibraryItem> {
	switch (provider) {
		case 'rd':
			return detailRealDebrid(token, itemId, signal);
		case 'ad':
			return detailAllDebrid(token, itemId, signal);
		case 'tb':
			return detailTorBox(token, itemId, signal);
		case 'pm':
			return detailPremiumize(token, itemId, signal);
		case 'oc':
			return detailOffcloud(token, itemId, signal);
		case 'dl':
			return detailDebridLink(token, itemId, signal);
	}
}

const fileById = (item: LibraryItem, fileId: string): LibraryFile => {
	const file = item.files.find((entry) => entry.id === fileId);
	if (!file) throw new ProviderApiError(item.provider, 'That file is no longer available.', 'not_found');
	return file;
};

async function resolveRdFile(token: string, item: LibraryItem, fileId: string, signal?: AbortSignal): Promise<string> {
	const file = fileById(item, fileId);
	let link = file.link;
	if (!link) {
		const result = await request<Record<string, unknown>>(
			'rd',
			`${RD_BASE}/torrents/info/${encodeURIComponent(rawId(item.id, 'rd'))}`,
			{ headers: authHeaders(token) },
			signal
		);
		link = rdFiles(result.body, true).find((entry) => entry.id === fileId)?.link;
		const links = Array.isArray(result.body.links) ? result.body.links : [];
		if (!link && links.length > 0 && rdStatus(result.body.status) === 'finished') {
			throw new ProviderApiError('rd', 'Real-Debrid packed the selected files into one archive, so this file has no link of its own. Select only the files you want to open.', 'archived_selection');
		}
	}
	if (!link) throw new ProviderApiError('rd', 'Real-Debrid has not selected a playable file yet.', 'file_unavailable');
	const result = await formRequest<Record<string, unknown>>('rd', `${RD_BASE}/unrestrict/link`, token, { link }, signal);
	const download = result.body.download;
	if (typeof download !== 'string' || !download) throw new ProviderApiError('rd', 'Real-Debrid returned no download link.', 'file_unavailable');
	return download;
}

async function resolveAdFile(token: string, item: LibraryItem, fileId: string, signal?: AbortSignal): Promise<string> {
	const file = fileById(item, fileId);
	let providerLink = file.link;
	if (!providerLink) {
		const result = await formRequest<{ status?: string; data?: unknown }>('ad', `${AD_BASE}/magnet/files`, token, { 'id[]': rawId(item.id, 'ad') }, signal);
		const body = assertAd(result.body);
		const data = assertObject(body.data, 'ad');
		const magnet = assertObject(asArray(data.magnets)[0], 'ad');
		const allFiles = flattenAdFiles(asArray(magnet.files));
		providerLink = allFiles.find((entry) => entry.id === fileId || entry.name === file.name)?.link;
	}
	if (!providerLink) throw new ProviderApiError('ad', 'AllDebrid returned no file link.', 'file_unavailable');
	if (!providerLink.includes('/f/')) return providerLink;
	const unlocked = await formRequest<{ status?: string; data?: unknown }>('ad', `${AD_BASE}/link/unlock`, token, { link: providerLink }, signal);
	const unlockedBody = assertAd(unlocked.body);
	const data = assertObject(unlockedBody.data, 'ad');
	const link = data.link;
	if (typeof link !== 'string' || !link) throw new ProviderApiError('ad', 'AllDebrid returned no unlocked file link.', 'file_unavailable');
	return link;
}

async function resolveTorBoxFile(token: string, item: LibraryItem, fileId: string, signal?: AbortSignal): Promise<string> {
	const file = fileById(item, fileId);
	const detail = torboxDetailPath(item.id);
	const path = detail.kind === 'torrent' ? 'torrents/requestdl' : detail.kind === 'web' ? 'webdl/requestdl' : 'usenet/requestdl';
	const params = new URLSearchParams();
	if (detail.kind === 'torrent') params.set('torrent_id', detail.id);
	else if (detail.kind === 'web') params.set('web_id', detail.id);
	else params.set('usenet_id', detail.id);
	params.set('file_id', file.id);
	params.set('token', token);
	const result = await request<unknown>(
		'tb',
		`${TB_BASE}/${path}?${params.toString()}`,
		{ headers: authHeaders(token) },
		signal
	);
	const body = assertTorBox(result.body);
	if (typeof body.data !== 'string' || !body.data) throw new ProviderApiError('tb', 'TorBox returned no download link.', 'file_unavailable');
	return body.data;
}

async function resolvePremiumizeFile(token: string, item: LibraryItem, fileId: string, signal?: AbortSignal): Promise<string> {
	const file = fileById(item, fileId);
	const result = await formRequest<Record<string, unknown>>('pm', `${PM_BASE}/item/details`, token, { id: file.id }, signal);
	const body = assertPremiumize(result.body);
	for (const key of ['link', 'directlink', 'stream_link']) {
		if (typeof body[key] === 'string' && body[key]) return body[key] as string;
	}
	throw new ProviderApiError('pm', 'Premiumize returned no file link.', 'file_unavailable');
}

async function resolveOffcloudFile(token: string, item: LibraryItem, fileId: string, signal?: AbortSignal): Promise<string> {
	const result = await request<unknown>('oc', `${OC_BASE}/cloud/explore/${encodeURIComponent(rawId(item.id, 'oc'))}`, { headers: authHeaders(token) }, signal);
	const body = assertOffcloud(result.body);
	const links = Array.isArray(body) ? body.filter((link): link is string => typeof link === 'string') : [];
	const file = fileById(item, fileId);
	return links.find((link) => basename(link) === file.name) ?? links[Number(file.id)] ?? (() => { throw new ProviderApiError('oc', 'Offcloud returned no file link.', 'file_unavailable'); })();
}

async function resolveDebridLinkFile(token: string, item: LibraryItem, fileId: string, signal?: AbortSignal): Promise<string> {
	const file = fileById(item, fileId);
	const result = await request<unknown>(
		'dl',
		`${DL_BASE}/seedbox/list?page=0&perPage=100&id=${encodeURIComponent(rawId(item.id, 'dl'))}&ids=${encodeURIComponent(rawId(item.id, 'dl'))}`,
		{ headers: authHeaders(token) },
		signal
	);
	const body = assertDebridLink(result.body);
	const row = asArray<Record<string, unknown>>(body.value).find((entry) => String(entry.id) === rawId(item.id, 'dl'));
	const files = row && Array.isArray(row.files) ? row.files : [];
	const resolved = files.find((entry) => String((entry as Record<string, unknown>).id) === fileId || displayName((entry as Record<string, unknown>).name) === file.name);
	const link = resolved && (resolved as Record<string, unknown>).downloadUrl;
	if (typeof link !== 'string' || !link) throw new ProviderApiError('dl', 'Debrid-Link returned no file link.', 'file_unavailable');
	return link;
}

export async function resolveFile(
	provider: ProviderId,
	token: string,
	item: LibraryItem,
	fileId: string,
	signal?: AbortSignal
): Promise<string> {
	switch (provider) {
		case 'rd':
			return resolveRdFile(token, item, fileId, signal);
		case 'ad':
			return resolveAdFile(token, item, fileId, signal);
		case 'tb':
			return resolveTorBoxFile(token, item, fileId, signal);
		case 'pm':
			return resolvePremiumizeFile(token, item, fileId, signal);
		case 'oc':
			return resolveOffcloudFile(token, item, fileId, signal);
		case 'dl':
			return resolveDebridLinkFile(token, item, fileId, signal);
	}
}

export interface AddOptions {
	/** TorBox and AllDebrid: add only what is cached already (a backup restore's default). */
	cachedOnly?: boolean;
}

const isVideoPath = (name: string): boolean => /\.(mkv|mp4|avi|m4v|mov|wmv|ts|m2ts|webm|mpg|mpeg|flv|vob|iso)$/i.test(name);

/** DMM web's selection after an RD add: every video, or every file when there is none. */
async function selectRdDefault(token: string, rdId: string, signal?: AbortSignal): Promise<void> {
	const info = await request<Record<string, unknown>>('rd', `${RD_BASE}/torrents/info/${encodeURIComponent(rdId)}`, { headers: authHeaders(token) }, signal);
	const files = rdFiles(info.body, false);
	if (files.length === 0 || info.body.status !== 'waiting_files_selection') return;
	const videos = files.filter((file) => isVideoPath(file.name));
	await formRequest('rd', `${RD_BASE}/torrents/selectFiles/${encodeURIComponent(rdId)}`, token, { files: (videos.length ? videos : files).map((file) => file.id).join(',') }, signal);
}

const rdAddedId = (body: Record<string, unknown>): string => {
	if (typeof body.id !== 'string' || !body.id) throw new ProviderApiError('rd', 'Real-Debrid returned no torrent id.', 'invalid_response');
	return body.id;
};

/** Adds a magnet, or a bare info hash. Debrid-Link takes a bare hash only when it is cached, which spares its daily quota. */
export async function addMagnet(
	provider: ProviderId,
	token: string,
	magnetOrHash: string,
	signal?: AbortSignal,
	options: AddOptions = {}
): Promise<void> {
	const bare = isBtih(magnetOrHash);
	const magnet = bare ? `magnet:?xt=urn:btih:${magnetOrHash.trim().toLowerCase()}` : magnetOrHash;
	if (!/^magnet:\?/i.test(magnet) || !isBtih(magnetHash(magnet))) {
		throw new ProviderApiError(provider, 'The magnet must contain a valid v1 BTIH.', 'invalid_magnet');
	}
	switch (provider) {
		case 'rd': {
			const result = await formRequest<Record<string, unknown>>('rd', `${RD_BASE}/torrents/addMagnet`, token, { magnet }, signal);
			await selectRdDefault(token, rdAddedId(result.body), signal);
			return;
		}
		case 'ad': {
			const result = await formRequest<Record<string, unknown>>('ad', `${AD_BASE}/magnet/upload`, token, { 'magnets[]': magnet }, signal);
			const body = assertAd(result.body);
			const data = assertObject(body.data, 'ad');
			const magnetResults = asArray<Record<string, unknown>>(data.magnets);
			const failed = magnetResults.find((entry) => entry.error);
			if (failed) throw new ProviderApiError('ad', errorText(failed.error, 'AllDebrid rejected the magnet.'), String(assertObject(failed.error, 'ad').code ?? 'provider_error'));
			if (!body.data) throw new ProviderApiError('ad', 'AllDebrid returned no magnet id.', 'invalid_response');
			// AllDebrid has no cache probe left: the upload reports `ready`, and a miss is removed again.
			const uploaded = magnetResults[0];
			if (options.cachedOnly && uploaded && uploaded.ready !== true) {
				await formRequest('ad', `${AD_BASE}/magnet/delete`, token, { id: String(uploaded.id) }, signal);
				throw new ProviderApiError('ad', 'Not cached on AllDebrid, so it was not kept.', 'not_cached');
			}
			return;
		}
		case 'tb': {
			const result = await formRequest<unknown>('tb', `${TB_BASE}/torrents/createtorrent`, token, { magnet, add_only_if_cached: options.cachedOnly ? 'true' : undefined }, signal);
			const body = assertTorBox(result.body);
			if (!body.data) throw new ProviderApiError('tb', 'TorBox returned no torrent id.', 'invalid_response');
			return;
		}
		case 'pm': {
			const result = await formRequest<Record<string, unknown>>('pm', `${PM_BASE}/transfer/create`, token, { src: magnet }, signal);
			assertPremiumize(result.body);
			return;
		}
		case 'oc': {
			const result = await jsonRequest<Record<string, unknown>>('oc', `${OC_BASE}/cloud`, token, { url: magnet }, signal);
			const body = assertOffcloud(result.body);
			if (typeof body.requestId !== 'string') throw new ProviderApiError('oc', 'Offcloud returned no request id.', 'invalid_response');
			return;
		}
		case 'dl': {
			const result = await formRequest<unknown>('dl', `${DL_BASE}/seedbox/add`, token, { url: bare ? magnetOrHash.trim().toLowerCase() : magnet }, signal);
			const body = assertDebridLink(result.body);
			if (!body.value) throw new ProviderApiError('dl', 'Debrid-Link returned no torrent.', 'invalid_response');
			return;
		}
	}
}

/** TorBox alone downloads plain web links. */
export async function addWebDownload(token: string, link: string, signal?: AbortSignal): Promise<void> {
	if (!/^https?:\/\//i.test(link)) throw new ProviderApiError('tb', 'Enter an http or https link.', 'invalid_link');
	const result = await formRequest<unknown>('tb', `${TB_BASE}/webdl/createwebdownload`, token, { link }, signal);
	assertTorBox(result.body);
}

export interface PickedFile {
	uri: string;
	name: string;
}

/** Uploads a .torrent file as each provider's own endpoint takes it. */
export async function addTorrentFile(provider: ProviderId, token: string, file: PickedFile, signal?: AbortSignal): Promise<void> {
	const part = { uri: file.uri, name: file.name, type: 'application/x-bittorrent' } as unknown as Blob;
	const multipart = async <T,>(url: string, field: string): Promise<T> => {
		const form = new FormData();
		form.append(field, part);
		return (await request<T>(provider, url, { method: 'POST', headers: authHeaders(token), body: form }, signal)).body;
	};
	switch (provider) {
		case 'rd': {
			const bytes = await (await fetch(file.uri)).blob();
			const result = await request<Record<string, unknown>>('rd', `${RD_BASE}/torrents/addTorrent`, { method: 'PUT', headers: { ...authHeaders(token), 'Content-Type': 'application/x-bittorrent' }, body: bytes }, signal);
			await selectRdDefault(token, rdAddedId(assertObject(result.body, 'rd')), signal);
			return;
		}
		case 'ad': {
			const body = assertAd(await multipart<unknown>(`${AD_BASE.replace('/v4.1', '/v4')}/magnet/upload/file`, 'files[]'));
			const refused = asArray<Record<string, unknown>>(assertObject(body.data, 'ad').files).find((entry) => entry.error);
			if (refused) throw new ProviderApiError('ad', errorText(refused.error, 'AllDebrid rejected the torrent file.'), 'provider_error');
			return;
		}
		case 'tb':
			assertTorBox(await multipart<unknown>(`${TB_BASE}/torrents/createtorrent`, 'file'));
			return;
		case 'pm':
			assertPremiumize(await multipart<unknown>(`${PM_BASE}/transfer/create`, 'src'));
			return;
		case 'oc': {
			const body = assertOffcloud(await multipart<unknown>(`${OC_BASE}/cloud`, 'file'));
			if (typeof body.requestId !== 'string') throw new ProviderApiError('oc', 'Offcloud returned no request id.', 'invalid_response');
			return;
		}
		case 'dl':
			assertDebridLink(await multipart<unknown>(`${DL_BASE}/seedbox/add`, 'file'));
			return;
	}
}

/**
 * Real-Debrid re-adds the hash with the same (or the given) files and deletes the old row;
 * TorBox reannounces an active torrent; AllDebrid restarts a failed magnet.
 */
export async function reinsertItem(token: string, item: LibraryItem, fileIds?: string[], signal?: AbortSignal): Promise<void> {
	if (item.provider === 'tb') {
		const result = await jsonRequest<unknown>('tb', `${TB_BASE}/torrents/controltorrent`, token, { torrent_id: Number(torboxDetailPath(item.id).id), operation: 'reannounce' }, signal);
		assertTorBox(result.body);
		return;
	}
	if (item.provider === 'ad') {
		const result = await formRequest<unknown>('ad', `${AD_BASE}/magnet/restart`, token, { id: rawId(item.id, 'ad') }, signal);
		assertAd(result.body);
		return;
	}
	if (item.provider !== 'rd') throw new ProviderApiError(item.provider, 'Premiumize, Offcloud and Debrid-Link have no reinsert.', 'unsupported');
	if (!isBtih(item.hash)) throw new ProviderApiError('rd', 'This item has no info hash to reinsert.', 'invalid_magnet');
	const info = async (id: string) => (await request<Record<string, unknown>>('rd', `${RD_BASE}/torrents/info/${encodeURIComponent(id)}`, { headers: authHeaders(token) }, signal)).body;
	const oldId = rawId(item.id, 'rd');
	const old = await info(oldId);
	const oldSelection = rdFiles(old, false).filter((file) => file.selected).map((file) => file.id);
	const selection = fileIds && fileIds.length > 0 ? fileIds : oldSelection;
	const added = await formRequest<Record<string, unknown>>('rd', `${RD_BASE}/torrents/addMagnet`, token, { magnet: `magnet:?xt=urn:btih:${item.hash}` }, signal);
	const newId = rdAddedId(added.body);
	if (selection.length > 0) await formRequest('rd', `${RD_BASE}/torrents/selectFiles/${encodeURIComponent(newId)}`, token, { files: selection.join(',') }, signal);
	else await selectRdDefault(token, newId, signal);
	if (fileIds && fileIds.length > 0 && old.progress === 100) {
		// RD caches a torrent's whole file set, not each subset: narrowing a finished one can start a fresh download.
		const fresh = await info(newId);
		const narrows = fileIds.length < oldSelection.length && fileIds.every((id) => oldSelection.includes(id));
		if (fresh.progress !== 100 && narrows) {
			await request('rd', `${RD_BASE}/torrents/delete/${encodeURIComponent(newId)}`, { method: 'DELETE', headers: authHeaders(token) }, signal);
			throw new ProviderApiError('rd', 'Real-Debrid has not cached this selection and would download it again; your torrent was left as it was.', 'not_cached');
		}
	}
	await request('rd', `${RD_BASE}/torrents/delete/${encodeURIComponent(oldId)}`, { method: 'DELETE', headers: authHeaders(token) }, signal);
}

const magnetHash = (magnet: string): string => {
	const query = new URLSearchParams(magnet.slice(magnet.indexOf('?') + 1));
	const xt = query.getAll('xt').find((value) => /^urn:btih:/i.test(value));
	return xt?.slice('urn:btih:'.length) ?? '';
};

export async function deleteLibraryItem(
	provider: ProviderId,
	token: string,
	itemId: string,
	signal?: AbortSignal
): Promise<void> {
	switch (provider) {
		case 'rd':
			await request('rd', `${RD_BASE}/torrents/delete/${encodeURIComponent(rawId(itemId, 'rd'))}`, { method: 'DELETE', headers: authHeaders(token) }, signal);
			return;
		case 'ad':
			{
				const result = await formRequest('ad', `${AD_BASE}/magnet/delete`, token, { id: rawId(itemId, 'ad') }, signal);
				assertAd(result.body);
			}
			return;
		case 'tb': {
			const detail = torboxDetailPath(itemId);
			const endpoint = detail.kind === 'torrent' ? 'torrents/controltorrent' : detail.kind === 'web' ? 'webdl/controlwebdownload' : 'usenet/controlusenetdownload';
			const key = detail.kind === 'torrent' ? 'torrent_id' : detail.kind === 'web' ? 'webdl_id' : 'usenet_id';
			const result = await jsonRequest<unknown>('tb', `${TB_BASE}/${endpoint}`, token, { [key]: Number(detail.id), operation: 'delete' }, signal);
			assertTorBox(result.body);
			return;
		}
		case 'pm': {
			const [kind, id] = itemId.split(':').slice(1);
			const endpoint = kind === 't' ? 'transfer/delete' : kind === 'f' ? 'folder/delete' : 'item/delete';
			const result = await formRequest<Record<string, unknown>>('pm', `${PM_BASE}/${endpoint}`, token, { id }, signal);
			assertPremiumize(result.body);
			return;
		}
		case 'oc': {
			const result = await request('oc', `${OC_BASE}/cloud/remove/${encodeURIComponent(rawId(itemId, 'oc'))}`, { headers: authHeaders(token) }, signal);
			assertOffcloud(result.body);
			return;
		}
		case 'dl': {
			const id = rawId(itemId, 'dl');
			const result = await request<unknown>('dl', `${DL_BASE}/seedbox/${encodeURIComponent(id)}/remove`, { method: 'DELETE', headers: authHeaders(token) }, signal);
			assertDebridLink(result.body);
			return;
		}
	}
}

export async function selectRealDebridFiles(
	token: string,
	itemId: string,
	fileIds: string[],
	signal?: AbortSignal
): Promise<void> {
	if (fileIds.length === 0) throw new ProviderApiError('rd', 'Select at least one file.', 'invalid_selection');
	await formRequest('rd', `${RD_BASE}/torrents/selectFiles/${encodeURIComponent(rawId(itemId, 'rd'))}`, token, { files: fileIds.join(',') }, signal);
}

export const _testing = {
	rdFiles,
	normalizeRd,
	normalizeAd,
	normalizeTorBox,
	buildPremiumizeItems,
	normalizeOffcloud,
	normalizeDebridLink,
	flattenAdFiles,
	formBody,
	magnetHash,
	resetDebridLinkFloodLockouts: () => dlFloodLockouts.clear(),
};
