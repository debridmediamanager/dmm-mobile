import type { LibraryItem, LibraryStatus, ProviderId, SortMode } from './model';

export interface LibraryQuery {
	search: string;
	provider: ProviderId | 'all';
	status: LibraryStatus | 'all';
	sort: SortMode;
}

export const EMPTY_QUERY: LibraryQuery = {
	search: '',
	provider: 'all',
	status: 'all',
	sort: 'newest',
};

export function filterAndSortLibrary(
	items: readonly LibraryItem[],
	query: LibraryQuery
): LibraryItem[] {
	const search = query.search.trim().toLocaleLowerCase();
	const filtered = items.filter((item) => {
		if (query.provider !== 'all' && item.provider !== query.provider) return false;
		if (query.status !== 'all' && item.status !== query.status) return false;
		if (!search) return true;
		return `${item.title}\n${item.filename}`.toLocaleLowerCase().includes(search);
	});

	return filtered.sort((a, b) => {
		if (query.sort === 'title') return a.title.localeCompare(b.title);
		if (query.sort === 'size') return b.size - a.size || a.title.localeCompare(b.title);
		return new Date(b.added).getTime() - new Date(a.added).getTime();
	});
}

export const transferItems = (items: readonly LibraryItem[]): LibraryItem[] =>
	items.filter(
		(item) => item.status === 'waiting' || item.status === 'downloading' || item.status === 'error'
	);

export const formatBytes = (bytes: number): string => {
	if (!Number.isFinite(bytes) || bytes <= 0) return 'Unknown size';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
	return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
};

export const filePath = (name: string, path?: string): string =>
	path ? `${path.replace(/^\/+|\/+$/g, '')}/${name}` : name;
