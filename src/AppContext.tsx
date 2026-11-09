import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { StoredCredential } from './auth';
import type { LibraryFile, LibraryItem, ProviderId } from './model';
import { LibrarySession, type SessionSnapshot } from './session';

interface AppContextValue {
	ready: boolean;
	startupError?: string;
	snapshot: SessionSnapshot;
	connect(provider: ProviderId, credential: string | StoredCredential): Promise<void>;
	disconnect(provider: ProviderId): Promise<void>;
	refreshAll(): Promise<void>;
	detail(provider: ProviderId, itemId: string): Promise<LibraryItem>;
	openFile(provider: ProviderId, item: LibraryItem, fileId: string): Promise<string>;
	add(provider: ProviderId, magnet: string): Promise<void>;
	remove(provider: ProviderId, itemId: string): Promise<void>;
	selectFiles(item: LibraryItem, files: LibraryFile[]): Promise<void>;
	retryStartup(): Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children, session: injectedSession }: { children: React.ReactNode; session?: LibrarySession }) {
	const session = useMemo(() => injectedSession ?? new LibrarySession(), [injectedSession]);
	const [ready, setReady] = useState(false);
	const [startupError, setStartupError] = useState('');
	const [snapshot, setSnapshot] = useState<SessionSnapshot>(() => session.snapshot());
	const sync = useCallback(() => setSnapshot(session.snapshot()), [session]);
	const bootstrap = useCallback(async () => {
		setReady(false);
		setStartupError('');
		try {
			await session.loadCredentials();
			setReady(true);
			sync();
			await session.refreshAll();
		} catch (error) {
			setStartupError(error instanceof Error ? error.message : 'Could not read secure account storage.');
			setReady(true);
		} finally {
			sync();
			setReady(true);
		}
	}, [session, sync]);

	useEffect(() => {
		const unsubscribe = session.subscribe(sync);
		void bootstrap();
		return unsubscribe;
	}, [bootstrap, session, sync]);

	const run = useCallback(
		async <T,>(operation: () => Promise<T>): Promise<T> => {
			const pending = operation();
			sync();
			try {
				return await pending;
			} finally {
				sync();
			}
		},
		[sync]
	);
	const connect = useCallback(
		(provider: ProviderId, credential: string | StoredCredential) => run(async () => {
			await session.connect(provider, credential);
			await session.refreshProvider(provider);
		}),
		[run, session]
	);
	const disconnect = useCallback((provider: ProviderId) => run(() => session.disconnect(provider)), [run, session]);
	const refreshAll = useCallback(() => run(() => session.refreshAll()), [run, session]);
	const detail = useCallback((provider: ProviderId, itemId: string) => run(() => session.detail(provider, itemId)), [run, session]);
	const openFile = useCallback((provider: ProviderId, item: LibraryItem, fileId: string) => session.openFile(provider, item, fileId), [session]);
	const add = useCallback((provider: ProviderId, magnet: string) => run(() => session.add(provider, magnet)), [run, session]);
	const remove = useCallback((provider: ProviderId, itemId: string) => run(() => session.remove(provider, itemId)), [run, session]);
	const selectFiles = useCallback((item: LibraryItem, files: LibraryFile[]) => run(() => session.selectFiles(item, files)), [run, session]);

	const value = useMemo<AppContextValue>(
		() => ({
			ready,
			startupError: startupError || undefined,
			snapshot,
			connect,
			disconnect,
			refreshAll,
			detail,
			openFile,
			add,
			remove,
			selectFiles,
			retryStartup: bootstrap,
		}),
		[add, bootstrap, connect, detail, disconnect, openFile, ready, refreshAll, remove, selectFiles, snapshot, startupError]
	);

	return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export const useApp = (): AppContextValue => {
	const context = useContext(AppContext);
	if (!context) throw new Error('useApp must be used inside AppProvider');
	return context;
};
