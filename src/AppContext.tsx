import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { StoredCredential } from './auth';
import type { LibraryFile, LibraryItem, ProviderId } from './model';
import { onSettingsChange } from './settings';
import { LibrarySession, type BulkResult, type SessionSnapshot } from './session';
import type { AddOptions, PickedFile } from './providerApi';
import type { AddEntry } from './share';
import type { BrowserState } from './sync';

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
	addMany(provider: ProviderId, entries: readonly AddEntry[], options?: AddOptions, onProgress?: (finished: number, total: number) => void): Promise<BulkResult>;
	addFile(provider: ProviderId, file: PickedFile): Promise<void>;
	reinsert(item: LibraryItem, fileIds?: string[]): Promise<void>;
	bulk(action: 'delete' | 'reinsert', items: readonly LibraryItem[], onProgress?: (finished: number, total: number) => void): Promise<BulkResult>;
	checkRdUncached(onProgress?: (done: number, total: number) => void): Promise<void>;
	retryStartup(): Promise<void>;
	/** Connects the logins a phone handed this TV through DMM's /tv pairing; returns the providers now connected. */
	linkState(state: BrowserState): Promise<ProviderId[]>;
	/** What a DMM page opened in the browser is signed in with (Search). */
	browserState(): Promise<BrowserState>;
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
		// A changed setting is saved across devices along with the logins.
		const unsubscribeSettings = onSettingsChange(() => session.schedulePush());
		void bootstrap();
		return () => {
			unsubscribe();
			unsubscribeSettings();
		};
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
	const addMany = useCallback((provider: ProviderId, entries: readonly AddEntry[], options?: AddOptions, onProgress?: (finished: number, total: number) => void) => run(() => session.addMany(provider, entries, options, onProgress)), [run, session]);
	const addFile = useCallback((provider: ProviderId, file: PickedFile) => run(() => session.addFile(provider, file)), [run, session]);
	const reinsert = useCallback((item: LibraryItem, fileIds?: string[]) => run(() => session.reinsert(item, fileIds)), [run, session]);
	const checkRdUncached = useCallback((onProgress?: (done: number, total: number) => void) => run(() => session.checkRdUncached(onProgress)), [run, session]);
	const linkState = useCallback((state: BrowserState) => run(async () => {
		const linked = await session.adoptState(state);
		session.schedulePush();
		return linked;
	}), [run, session]);
	const browserState = useCallback(() => session.browserState(), [session]);
	const bulk = useCallback((action: 'delete' | 'reinsert', items: readonly LibraryItem[], onProgress?: (finished: number, total: number) => void) => run(() => session.bulk(action, items, onProgress)), [run, session]);

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
			addMany,
			addFile,
			reinsert,
			bulk,
			checkRdUncached,
			retryStartup: bootstrap,
			linkState,
			browserState,
		}),
		[add, addFile, addMany, browserState, bulk, checkRdUncached, linkState, reinsert, bootstrap, connect, detail, disconnect, openFile, ready, refreshAll, remove, selectFiles, snapshot, startupError]
	);

	return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export const useApp = (): AppContextValue => {
	const context = useContext(AppContext);
	if (!context) throw new Error('useApp must be used inside AppProvider');
	return context;
};
