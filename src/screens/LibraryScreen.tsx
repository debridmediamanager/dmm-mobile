import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import {
	ActivityIndicator,
	Alert,
	FlatList,
	KeyboardAvoidingView,
	Linking,
	Modal,
	Platform,
	Pressable,
	RefreshControl,
	ScrollView,
	Share,
	Switch,
	Text,
	TextInput,
	View,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useApp } from '../AppContext';
import {
	duplicatesToDelete,
	EMPTY_QUERY,
	filterLibrary,
	sortLibrary,
	formatAgo,
	formatBytes,
	groupLibrary,
	hashKeyOf,
	mediaTypeOf,
	sameHashMergeGroups,
	titleKeyOf,
	type DuplicateRule,
	type LibraryQuery,
	type LibraryView,
} from '../core';
import type { LibraryItem, MediaType, ProviderId, SortMode } from '../model';
import { PROVIDERS, PROVIDER_META } from '../model';
import type { BulkResult } from '../session';
import { loadSettings, saveSetting } from '../settings';
import { backupJson, hashlistUrl, parseAddInput, parseBackup, shareableItems } from '../share';
import { magnetForHash } from '../validation';
import type { RootStackParamList } from '../navigation';
import { useAppTheme } from '../theme';
import { confirmNativeAction } from '../confirmAction';
import { ActionSheet, DropdownChip, EmptyState, ErrorBanner, FilterButton, LibraryRow, ROW_HEIGHT, Screen, styles, type SheetAction } from '../ui';

type Navigation = NativeStackNavigationProp<RootStackParamList, 'Main'>;

const views: Array<{ value: LibraryView; label: string }> = [
	{ value: 'all', label: 'All' },
	{ value: 'inprogress', label: 'In progress' },
	{ value: 'slow', label: 'Slow' },
	{ value: 'failed', label: 'Failed' },
	{ value: 'uncached', label: 'Uncached' },
	{ value: 'rdblocked', label: 'RD blocked' },
	{ value: 'samehash', label: 'Same hash' },
	{ value: 'sametitle', label: 'Same title' },
	{ value: 'selected', label: 'Selected' },
];
const medias: Array<{ value: MediaType | 'all'; label: string }> = [
	{ value: 'all', label: 'Any type' },
	{ value: 'movie', label: 'Movies' },
	{ value: 'tv', label: 'TV' },
	{ value: 'other', label: 'Other' },
];
const sortModes: SortMode[] = ['newest', 'oldest', 'title', 'size', 'progress'];

const summarize = (verb: string, result: BulkResult): string =>
	`${verb} ${result.done}.${result.failed.length ? ` ${result.failed.length} failed:\n${result.failed.slice(0, 5).map((entry) => `${entry.label}: ${entry.message}`).join('\n')}` : ''}`;

const shareMagnet = (item: LibraryItem) => {
	try {
		void Share.share({ message: magnetForHash(item.hash, item.title) }).catch(() => Alert.alert('Magnet unavailable', 'The native share sheet could not open.'));
	} catch {
		Alert.alert('Magnet unavailable', 'This provider item has no valid BTIH to share.');
	}
};

/** A magnet handed to the app (magnet: link, or dmm-library://add?magnet=…). */
const magnetFromUrl = (url: string | null | undefined): string | null => {
	if (!url) return null;
	if (/^magnet:\?/i.test(url)) return url;
	const match = url.match(/[?&]magnet=([^&]+)/);
	return match ? decodeURIComponent(match[1]) : null;
};

export function LibraryScreen({ navigation }: { navigation: Navigation }) {
	const theme = useAppTheme();
	const { ready, startupError, snapshot, refreshAll, retryStartup, bulk, remove, reinsert, checkRdUncached } = useApp();
	const [query, setQuery] = useState<LibraryQuery>(EMPTY_QUERY);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [adding, setAdding] = useState<{ text: string } | null>(null);
	const [restoring, setRestoring] = useState(false);
	const [sheet, setSheet] = useState(false);
	const [picker, setPicker] = useState<'sort' | 'provider' | 'media' | 'view' | null>(null);
	const [rowMenu, setRowMenu] = useState<LibraryItem | null>(null);
	const [progress, setProgress] = useState('');
	const baseItems = snapshot.items;
	const grouping = useMemo(() => groupLibrary(baseItems), [baseItems]);
	const sorted = useMemo(() => sortLibrary(baseItems, query.sort), [baseItems, query.sort]);
	// The search field renders each keystroke at once; the list follows when React has time.
	const deferredQuery = useDeferredValue(query);
	const items = useMemo(() => filterLibrary(sorted, { ...deferredQuery, selected }, grouping), [sorted, grouping, deferredQuery, selected]);
	const connectedProviders = PROVIDERS.filter((id) => snapshot.connected[id]);
	const refreshing = Object.values(snapshot.loading).some(Boolean);
	const set = (patch: Partial<LibraryQuery>) => setQuery((current) => ({ ...current, ...patch }));
	const selectedItems = snapshot.items.filter((item) => selected.has(item.id));
	// As on DMM web, bulk actions take the selection, or everything shown when nothing is selected.
	const targets = selectedItems.length > 0 ? selectedItems : items;
	const targetLabel = selectedItems.length > 0 ? `${selectedItems.length} selected` : `${items.length} shown`;

	useEffect(() => {
		const open = (url: string | null | undefined) => {
			const magnet = magnetFromUrl(url);
			if (magnet) setAdding({ text: magnet });
		};
		void Linking.getInitialURL().then(open);
		const subscription = Linking.addEventListener('url', (event) => open(event.url));
		return () => subscription.remove();
	}, []);

	// Real-Debrid's list cannot tell cached rows from uncached ones; look them up when that view is opened.
	const checkingRd = useRef(false);
	useEffect(() => {
		if (query.view !== 'uncached' || !snapshot.connected.rd || snapshot.rdUncachedChecked || checkingRd.current) return;
		checkingRd.current = true;
		setProgress('Checking Real-Debrid links…');
		void checkRdUncached((done, total) => setProgress(`Checking Real-Debrid links ${done}/${total}…`))
			.catch((error) => Alert.alert('Real-Debrid check failed', error instanceof Error ? error.message : String(error)))
			.finally(() => {
				checkingRd.current = false;
				setProgress('');
			});
	}, [checkRdUncached, query.view, snapshot.connected.rd, snapshot.rdUncachedChecked]);

	// Rows that left the library leave the selection too.
	useEffect(() => {
		setSelected((current) => {
			const ids = new Set(snapshot.items.map((item) => item.id));
			const kept = [...current].filter((id) => ids.has(id));
			return kept.length === current.size ? current : new Set(kept);
		});
	}, [snapshot.items]);

	const toggle = useCallback((item: LibraryItem) =>
		setSelected((current) => {
			const next = new Set(current);
			if (next.has(item.id)) next.delete(item.id);
			else next.add(item.id);
			return next;
		}), []);
	// Row callbacks stay stable so memoized rows re-render only when their own props change.
	const selectingRef = useRef(false);
	selectingRef.current = selected.size > 0;
	const openRow = useCallback((item: LibraryItem) => (selectingRef.current ? toggle(item) : navigation.navigate('Detail', { itemId: item.id })), [navigation, toggle]);
	const groupRow = useCallback((item: LibraryItem, group: 'hash' | 'title') =>
		setQuery((current) => ({ ...current, ...(group === 'hash' ? { hashKey: hashKeyOf(item), titleKey: undefined } : { titleKey: titleKeyOf(item), hashKey: undefined }) })), []);

	const runBulk = (verb: string, action: 'delete' | 'reinsert', rows: readonly LibraryItem[]) => {
		setProgress(`${verb} 0/${rows.length}…`);
		void bulk(action, rows, (finished, total) => setProgress(`${verb} ${finished}/${total}…`))
			.then((result) => {
				setSelected(new Set());
				Alert.alert(verb, summarize(action === 'delete' ? 'Deleted' : 'Reinserted', result));
			})
			.finally(() => setProgress(''));
	};

	const confirmBulk = (action: 'delete' | 'reinsert', rows: readonly LibraryItem[]) => {
		const eligible = action === 'reinsert' ? rows.filter((item) => item.reinsertable) : rows;
		if (eligible.length === 0) {
			Alert.alert('Nothing to reinsert', 'Premiumize, Offcloud and Debrid-Link have no reinsert, TorBox reannounces only active torrents, and AllDebrid restarts only failed ones.');
			return;
		}
		const verb = action === 'delete' ? 'Deleting' : 'Reinserting';
		confirmNativeAction(
			action === 'delete' ? `Delete ${eligible.length}?` : `Reinsert ${eligible.length}?`,
			`${action === 'delete' ? 'Remove' : 'Reinsert'} ${eligible.length} item${eligible.length === 1 ? '' : 's'} on their providers.${eligible.length < rows.length ? ` ${rows.length - eligible.length} cannot be reinserted and are skipped.` : ''}`,
			() => runBulk(verb, action, eligible),
			action === 'delete' ? 'Delete' : 'Reinsert'
		);
	};

	const shareHashlist = (rows: readonly LibraryItem[]) => {
		const shareable = shareableItems(rows);
		if (shareable.length === 0) {
			Alert.alert('Nothing to share', 'None of these have an info hash.');
			return;
		}
		const skipped = rows.length - shareable.length;
		const title = query.search.trim() || (query.provider === 'all' ? 'My library' : PROVIDER_META[query.provider].label);
		void Share.share({ message: hashlistUrl(title, shareable) }).then(() => {
			if (skipped > 0) Alert.alert('Hash list shared', `${skipped} item${skipped === 1 ? '' : 's'} with no info hash were left out.`);
		});
	};

	const backup = (rows: readonly LibraryItem[]) => {
		const shareable = shareableItems(rows);
		if (shareable.length === 0) {
			Alert.alert('Nothing to back up', 'None of these have an info hash.');
			return;
		}
		void Share.share({ title: `backup-${Date.now()}.dmm.json`, message: backupJson(shareable) });
	};

	const deleteDuplicates = (rule: DuplicateRule) => {
		const doomed = duplicatesToDelete(items, rule);
		if (doomed.length === 0) Alert.alert('No duplicates', 'Every title shown has one copy.');
		else confirmBulk('delete', doomed);
	};

	const mergeSameHash = () => {
		const groups = sameHashMergeGroups(items);
		if (groups.length === 0) {
			Alert.alert('Nothing to merge', 'No finished items share a hash on one provider.');
			return;
		}
		const keep = groups.map((group) => group[group.length - 1]);
		const doomed = groups.flatMap((group) => group.slice(0, -1));
		confirmNativeAction(
			`Merge ${groups.length} hash${groups.length === 1 ? '' : 'es'}?`,
			`Keeps one copy of each (${doomed.length} deleted) and reinserts the copy kept where the provider can.`,
			() => {
				setProgress('Merging…');
				void bulk('delete', doomed)
					.then((deleted) => bulk('reinsert', keep.filter((item) => item.reinsertable)).then((reinserted) => Alert.alert('Merged', `${summarize('Deleted', deleted)}\n${summarize('Reinserted', reinserted)}`)))
					.finally(() => setProgress(''));
			},
			'Merge'
		);
	};

	const actions: SheetAction[] = [
		{ label: `Select shown (${items.length})`, onPress: () => setSelected(new Set([...selected, ...items.map((item) => item.id)])) },
		...(selected.size > 0 ? [{ label: 'Unselect all', onPress: () => setSelected(new Set()) }] : []),
		{ label: `Reinsert ${targetLabel}`, onPress: () => confirmBulk('reinsert', targets) },
		{ label: `Share hash list of ${targetLabel}`, onPress: () => shareHashlist(targets) },
		{ label: `Back up ${targetLabel}`, onPress: () => backup(targets) },
		{ label: 'Restore a backup', onPress: () => setRestoring(true) },
		...(query.view === 'sametitle' || query.titleKey
			? (['smaller', 'bigger', 'older', 'newer'] as DuplicateRule[]).map((rule) => ({ label: `Delete ${rule} duplicates`, onPress: () => deleteDuplicates(rule), destructive: true }))
			: []),
		...(query.view === 'samehash' || query.hashKey ? [{ label: 'Merge same hash', onPress: mergeSameHash, destructive: true }] : []),
		{ label: `Delete ${targetLabel}`, onPress: () => confirmBulk('delete', targets), destructive: true },
	];

	const filtersActive = query.titleKey || query.hashKey;
	const visibleViews = views.filter((view) => view.value !== 'rdblocked' || snapshot.connected.rd);
	const check = (on: boolean, label: string) => `${on ? '✓ ' : ''}${label}`;
	const pickerSheets: Record<NonNullable<typeof picker>, { title: string; actions: SheetAction[] }> = {
		sort: { title: 'Sort', actions: sortModes.map((value) => ({ label: check(query.sort === value, value[0].toUpperCase() + value.slice(1)), onPress: () => set({ sort: value }) })) },
		provider: { title: 'Provider', actions: picker !== 'provider' ? [] : [{ label: check(query.provider === 'all', 'All providers'), onPress: () => set({ provider: 'all' }) }, ...connectedProviders.map((id) => ({ label: check(query.provider === id, `${PROVIDER_META[id].label} (${baseItems.filter((item) => item.provider === id).length})`), onPress: () => set({ provider: id }) }))] },
		media: { title: 'Type', actions: medias.map((media) => ({ label: check(query.media === media.value, media.label), onPress: () => set({ media: media.value }) })) },
		view: { title: 'Show', actions: visibleViews.map((view) => ({ label: check(query.view === view.value, view.value === 'selected' ? `Selected (${selected.size})` : view.label), onPress: () => set({ view: view.value }) })) },
	};
	const rowActions = (item: LibraryItem): SheetAction[] => [
		{ label: 'Details and files', onPress: () => navigation.navigate('Detail', { itemId: item.id }) },
		{ label: selected.has(item.id) ? 'Unselect' : 'Select', onPress: () => toggle(item) },
		...(item.hash && (grouping.hashCounts.get(hashKeyOf(item)) ?? 0) > 1 ? [{ label: `Show the ${grouping.hashCounts.get(hashKeyOf(item))} with this hash`, onPress: () => groupRow(item, 'hash') }] : []),
		...((grouping.titleCounts.get(titleKeyOf(item)) ?? 0) > 1 ? [{ label: `Show the ${grouping.titleCounts.get(titleKeyOf(item))} with this title`, onPress: () => groupRow(item, 'title') }] : []),
		{ label: 'Share magnet', onPress: () => shareMagnet(item) },
		{ label: 'Share hash list link', onPress: () => shareHashlist([item]) },
		...(item.reinsertable ? [{ label: 'Reinsert', onPress: () => confirmNativeAction('Reinsert?', item.title, () => void reinsert(item).catch((error) => Alert.alert('Reinsert failed', error instanceof Error ? error.message : String(error))), 'Reinsert') }] : []),
		{ label: 'Delete', destructive: true, onPress: () => confirmNativeAction('Delete?', `Remove “${item.title}” from ${PROVIDER_META[item.provider].label}?`, () => void remove(item.provider, item.id).catch((error) => Alert.alert('Delete failed', error instanceof Error ? error.message : String(error))), 'Delete') },
	];
	const sortLabel = query.sort[0].toUpperCase() + query.sort.slice(1);
	const viewLabel = visibleViews.find((view) => view.value === query.view)?.label ?? 'All';

	return (
		<Screen>
			<View style={{ paddingHorizontal: 12, paddingTop: 6, gap: 6 }}>
				<View style={styles.rowBetween}>
					<View style={{ flex: 1 }}>
						<Text style={{ color: theme.text, fontSize: 20, fontWeight: '700' }}>Library</Text>
						<Text numberOfLines={1} style={{ color: progress ? theme.accent : theme.muted, fontSize: 12 }}>
							{progress || `${items.length === baseItems.length ? `${baseItems.length} item${baseItems.length === 1 ? '' : 's'}` : `${items.length} of ${baseItems.length} shown`} · ${formatBytes(grouping.totalBytes)}${snapshot.fetchedAt ? ` · ${formatAgo(snapshot.fetchedAt)}` : ''}${selected.size ? ` · ${selected.size} selected` : ''}`}
						</Text>
					</View>
					<Pressable accessibilityRole="button" accessibilityLabel={"Refresh library"} onPress={() => void refreshAll()} disabled={refreshing} style={[styles.outlineButton, { minHeight: 34, borderColor: snapshot.failures.length ? theme.danger : theme.accent, opacity: refreshing ? 0.55 : 1 }]}><Text style={[styles.outlineButtonText, { color: snapshot.failures.length ? theme.danger : theme.accent }]}>{refreshing ? 'Refreshing…' : 'Refresh'}</Text></Pressable>
					<Pressable accessibilityRole="button" accessibilityLabel="Add to library" onPress={() => setAdding({ text: '' })} style={[styles.primaryButton, { minHeight: 34, backgroundColor: theme.accent }]}><Text style={[styles.primaryButtonText, { color: theme.onAccent }]}>Add</Text></Pressable>
				</View>
				<TextInput
					accessibilityLabel="Search library"
					value={query.search}
					onChangeText={(search) => set({ search })}
					placeholder="Search names (regex), id, hash or status"
					placeholderTextColor={theme.muted}
					autoCapitalize="none"
					autoCorrect={false}
					style={{ borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 7, fontSize: 15, backgroundColor: theme.input, borderColor: theme.border, color: theme.text }}
				/>
			</View>
			<View style={[styles.row, { paddingRight: 12, gap: 0 }]}>
				<ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 6, gap: 6 }}>
					<DropdownChip label={sortLabel} active={query.sort !== 'newest'} onPress={() => setPicker('sort')} />
					<DropdownChip label={query.provider === 'all' ? 'Provider' : PROVIDER_META[query.provider].label} active={query.provider !== 'all'} onPress={() => setPicker('provider')} />
					<DropdownChip label={medias.find((media) => media.value === query.media)?.label ?? 'Any type'} active={query.media !== 'all'} onPress={() => setPicker('media')} />
					<DropdownChip label={query.view === 'selected' ? `Selected (${selected.size})` : viewLabel} active={query.view !== 'all'} onPress={() => setPicker('view')} />
				{filtersActive ? <FilterButton label={`${query.titleKey ? 'One title' : 'One hash'} ✕`} active onPress={() => set({ titleKey: undefined, hashKey: undefined })} /> : null}
				{JSON.stringify({ ...query, search: '' }) !== JSON.stringify({ ...EMPTY_QUERY, search: '' }) ? <FilterButton label="Reset" active={false} onPress={() => setQuery({ ...EMPTY_QUERY, search: query.search })} /> : null}
				</ScrollView>
				<Pressable accessibilityRole="button" accessibilityLabel="Library actions" disabled={Boolean(progress)} onPress={() => setSheet(true)} style={[styles.outlineButton, { minHeight: 32, marginLeft: 6, borderColor: theme.accent, opacity: progress ? 0.55 : 1 }]}>
					{progress ? <ActivityIndicator color={theme.accent} /> : <Text style={[styles.outlineButtonText, { color: theme.accent }]}>{selected.size ? `Actions (${selected.size})` : 'Actions'}</Text>}
				</Pressable>
			</View>
			{startupError ? <ErrorBanner message={`Secure account storage: ${startupError}`} actionLabel="Retry secure account load" onAction={() => void retryStartup()} busy={!ready} /> : null}
			{snapshot.failures.length > 0 ? <ErrorBanner message={snapshot.failures.map((failure) => `${PROVIDER_META[failure.provider].label}: ${failure.message}`).join('\n')} actionLabel="Retry library" onAction={() => void refreshAll()} busy={refreshing} /> : null}
			{!ready ? <EmptyState title="Unlocking secure accounts…" detail="Provider credentials are read from the device secure store." /> : items.length === 0 ? (
				<View>
					<EmptyState
						title={refreshing ? 'Loading library…' : snapshot.items.length === 0 ? (connectedProviders.length === 0 ? 'Connect a provider to start' : 'Your library is empty') : 'No matching items'}
						detail={snapshot.items.length === 0 && connectedProviders.length === 0 ? 'Open Accounts to validate a provider API key.' : undefined}
					/>
					<Pressable accessibilityRole="button" accessibilityLabel={"Retry library"} onPress={() => void refreshAll()} disabled={refreshing} style={[styles.primaryButton, { alignSelf: 'center', backgroundColor: theme.accent, opacity: refreshing ? 0.55 : 1 }]}><Text style={[styles.primaryButtonText, { color: theme.onAccent }]}>{refreshing ? 'Refreshing…' : 'Refresh library'}</Text></Pressable>
				</View>
			) : (
				<FlatList
					data={items}
					keyExtractor={(item) => item.id}
					extraData={selected}
					getItemLayout={(_, index) => ({ length: ROW_HEIGHT, offset: ROW_HEIGHT * index, index })}
					initialNumToRender={20}
					maxToRenderPerBatch={30}
					windowSize={11}
					removeClippedSubviews
					renderItem={({ item }) => (
						<LibraryRow
							item={item}
							mediaType={mediaTypeOf(item)}
							selected={selected.has(item.id)}
							selecting={selected.size > 0}
							hashCount={item.hash && !query.hashKey ? grouping.hashCounts.get(hashKeyOf(item)) ?? 0 : 0}
							titleCount={query.titleKey ? 0 : grouping.titleCounts.get(titleKeyOf(item)) ?? 0}
							onPress={openRow}
							onLongPress={toggle}
							onMore={setRowMenu}
						/>
					)}
					refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refreshAll()} tintColor={theme.accent} />}
					contentContainerStyle={{ paddingBottom: 24 }}
				/>
			)}
			{picker ? <ActionSheet title={pickerSheets[picker].title} actions={pickerSheets[picker].actions} onClose={() => setPicker(null)} /> : null}
			{rowMenu ? <ActionSheet title={rowMenu.title} detail={`${PROVIDER_META[rowMenu.provider].label} · ${formatBytes(rowMenu.size)}`} actions={rowActions(rowMenu)} onClose={() => setRowMenu(null)} /> : null}
			{sheet ? <ActionSheet title="Library actions" detail={`Acts on ${targetLabel}. Long press an item to select it.`} actions={actions} onClose={() => setSheet(false)} /> : null}
			{adding ? <AddModal initialText={adding.text} connectedProviders={connectedProviders} onClose={() => setAdding(null)} /> : null}
			{restoring ? <RestoreModal connectedProviders={connectedProviders} onClose={() => setRestoring(false)} /> : null}
		</Screen>
	);
}

/** The provider the last add went to, DMM web's `settings:addMagnetProvider`. */
function useAddProvider(connectedProviders: ProviderId[]): [ProviderId | null, (provider: ProviderId) => void] {
	const [provider, setProvider] = useState<ProviderId | null>(connectedProviders[0] ?? null);
	useEffect(() => {
		void loadSettings().then(({ addProvider }) => {
			if (addProvider && connectedProviders.includes(addProvider as ProviderId)) setProvider(addProvider as ProviderId);
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
	const choose = (next: ProviderId) => {
		setProvider(next);
		void saveSetting('addProvider', next).catch(() => undefined);
	};
	return [provider, choose];
}

function AddModal({ initialText, connectedProviders, onClose }: { initialText: string; connectedProviders: ProviderId[]; onClose: () => void }) {
	const theme = useAppTheme();
	const { addMany, addFile } = useApp();
	const [provider, setProvider] = useAddProvider(connectedProviders);
	const [text, setText] = useState(initialText);
	const [error, setError] = useState('');
	const [busy, setBusy] = useState('');

	const submit = async () => {
		setError('');
		if (!provider) {
			setError('Connect a provider in Accounts first.');
			return;
		}
		const { entries, invalid } = parseAddInput(text);
		if (entries.length === 0) {
			setError(invalid.length ? `Not a magnet, info hash or link: ${invalid.slice(0, 3).join(', ')}` : 'Paste a magnet, an info hash or a web link.');
			return;
		}
		if (provider !== 'tb' && entries.some((entry) => entry.kind === 'url')) {
			setError('Only TorBox downloads web links. Choose TorBox or remove the links.');
			return;
		}
		setBusy(`Adding 0/${entries.length}…`);
		try {
			const result = await addMany(provider, entries, {}, (finished, total) => setBusy(`Adding ${finished}/${total}…`));
			if (result.failed.length === 0 && invalid.length === 0) onClose();
			else setError(`${summarize('Added', result)}${invalid.length ? `\nSkipped ${invalid.length} unreadable: ${invalid.slice(0, 3).join(', ')}` : ''}`);
		} finally {
			setBusy('');
		}
	};

	const pickTorrent = async () => {
		setError('');
		if (!provider) return;
		const picked = await DocumentPicker.getDocumentAsync({ type: ['application/x-bittorrent', 'application/octet-stream', '*/*'], multiple: true, copyToCacheDirectory: true });
		if (picked.canceled) return;
		const failures: string[] = [];
		for (const [index, asset] of picked.assets.entries()) {
			setBusy(`Uploading ${index + 1}/${picked.assets.length}…`);
			try {
				await addFile(provider, { uri: asset.uri, name: asset.name });
			} catch (caught) {
				failures.push(`${asset.name}: ${caught instanceof Error ? caught.message : 'upload failed'}`);
			}
		}
		setBusy('');
		if (failures.length) setError(failures.join('\n'));
		else onClose();
	};

	return (
		<Modal visible animationType="slide" transparent onRequestClose={onClose}>
			<KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.modalBackdrop}>
				<ScrollView keyboardShouldPersistTaps="handled" style={[styles.modalSheet, { backgroundColor: theme.surface, maxHeight: '90%', width: '100%' }]} contentContainerStyle={{ gap: 12 }}>
					<View style={styles.rowBetween}><Text style={[styles.modalTitle, { color: theme.text }]}>Add to library</Text><Pressable accessibilityRole="button" accessibilityLabel="Close add" onPress={onClose}><Text style={{ color: theme.accent, fontWeight: '700' }}>Close</Text></Pressable></View>
					<View style={styles.modalButtonRow}>{connectedProviders.map((id) => <FilterButton key={id} label={PROVIDER_META[id].label} active={provider === id} onPress={() => setProvider(id)} />)}</View>
					<TextInput accessibilityLabel="Magnets, hashes or links" value={text} onChangeText={setText} placeholder={'Magnets or info hashes, one per line\n(TorBox also takes web links)'} placeholderTextColor={theme.muted} autoCapitalize="none" autoCorrect={false} multiline style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.text, minHeight: 110, textAlignVertical: 'top' }]} />
					{provider === 'dl' ? <Text style={[styles.subheading, { color: theme.muted }]}>Debrid-Link adds a bare hash only when it is cached; paste a magnet to download it.</Text> : null}
					{error ? <Text style={[styles.inlineError, { color: theme.danger }]}>{error}</Text> : null}
					<Pressable accessibilityRole="button" accessibilityLabel="Submit magnets" onPress={() => void submit()} disabled={Boolean(busy) || !text.trim()} style={[styles.primaryButton, { backgroundColor: theme.accent, opacity: busy || !text.trim() ? 0.55 : 1 }]}>{busy ? <Text style={[styles.primaryButtonText, { color: theme.onAccent }]}>{busy}</Text> : <Text style={[styles.primaryButtonText, { color: theme.onAccent }]}>Add</Text>}</Pressable>
					<Pressable accessibilityRole="button" accessibilityLabel="Upload torrent files" onPress={() => void pickTorrent()} disabled={Boolean(busy) || !provider} style={[styles.outlineButton, { borderColor: theme.accent, alignItems: 'center', minHeight: 44, opacity: busy ? 0.55 : 1 }]}><Text style={[styles.outlineButtonText, { color: theme.accent }]}>Upload .torrent files</Text></Pressable>
				</ScrollView>
			</KeyboardAvoidingView>
		</Modal>
	);
}

function RestoreModal({ connectedProviders, onClose }: { connectedProviders: ProviderId[]; onClose: () => void }) {
	const theme = useAppTheme();
	const { snapshot, addMany } = useApp();
	const [provider, setProvider] = useState<ProviderId | null>(connectedProviders[0] ?? null);
	const [hashes, setHashes] = useState<string[] | null>(null);
	const [cachedOnly, setCachedOnly] = useState(true);
	const [error, setError] = useState('');
	const [busy, setBusy] = useState('');
	const existing = new Set(snapshot.items.filter((item) => item.provider === provider).map((item) => item.hash));
	const fresh = (hashes ?? []).filter((hash) => !existing.has(hash));

	const pick = async () => {
		setError('');
		const picked = await DocumentPicker.getDocumentAsync({ type: ['application/json', '*/*'], copyToCacheDirectory: true });
		if (picked.canceled) return;
		try {
			setHashes(parseBackup(await (await fetch(picked.assets[0].uri)).text()));
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : 'Could not read that file.');
		}
	};

	const restore = async () => {
		if (!provider || fresh.length === 0) return;
		setBusy(`Restoring 0/${fresh.length}…`);
		try {
			const result = await addMany(provider, fresh.map((hash) => ({ kind: 'hash' as const, hash })), { cachedOnly: (provider === 'tb' || provider === 'ad') && cachedOnly }, (finished, total) => setBusy(`Restoring ${finished}/${total}…`));
			Alert.alert('Restore finished', summarize('Restored', result));
			onClose();
		} finally {
			setBusy('');
		}
	};

	return (
		<Modal visible animationType="slide" transparent onRequestClose={onClose}>
			<View style={styles.modalBackdrop}>
				<ScrollView style={[styles.modalSheet, { backgroundColor: theme.surface, maxHeight: '90%' }]} contentContainerStyle={{ gap: 12 }}>
					<View style={styles.rowBetween}><Text style={[styles.modalTitle, { color: theme.text }]}>Restore a backup</Text><Pressable accessibilityRole="button" accessibilityLabel="Close restore" onPress={onClose}><Text style={{ color: theme.accent, fontWeight: '700' }}>Close</Text></Pressable></View>
					<Text style={[styles.subheading, { color: theme.muted }]}>A .dmm.json from DMM web or this app. Hashes already on the provider are skipped.</Text>
					<View style={styles.modalButtonRow}>{connectedProviders.map((id) => <FilterButton key={id} label={PROVIDER_META[id].label} active={provider === id} onPress={() => setProvider(id)} />)}</View>
					<Pressable accessibilityRole="button" accessibilityLabel="Choose backup file" onPress={() => void pick()} style={[styles.outlineButton, { borderColor: theme.accent, alignItems: 'center', minHeight: 44 }]}><Text style={[styles.outlineButtonText, { color: theme.accent }]}>{hashes ? 'Choose another file' : 'Choose backup file'}</Text></Pressable>
					{hashes ? <Text style={[styles.subheading, { color: theme.text }]}>{hashes.length} hashes · {hashes.length - fresh.length} already there · {fresh.length} to restore</Text> : null}
					{provider === 'tb' || provider === 'ad' ? (
						<View style={styles.rowBetween}><Text style={{ color: theme.text, flex: 1 }}>Only restore cached items</Text><Switch accessibilityLabel="Only restore cached items" value={cachedOnly} onValueChange={setCachedOnly} /></View>
					) : null}
					{error ? <Text style={[styles.inlineError, { color: theme.danger }]}>{error}</Text> : null}
					<Pressable accessibilityRole="button" accessibilityLabel="Restore" onPress={() => void restore()} disabled={Boolean(busy) || fresh.length === 0} style={[styles.primaryButton, { backgroundColor: theme.accent, opacity: busy || fresh.length === 0 ? 0.55 : 1 }]}><Text style={[styles.primaryButtonText, { color: theme.onAccent }]}>{busy || `Restore ${fresh.length}`}</Text></Pressable>
				</ScrollView>
			</View>
		</Modal>
	);
}
