import { useEffect, useRef, useState } from 'react';
import {
	ActivityIndicator,
	Alert,
	Pressable,
	ScrollView,
	Share,
	Text,
	View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useApp } from '../AppContext';
import { formatBytes, isVideoName } from '../core';
import { hashlistUrl } from '../share';
import { openFileLink } from '../player';
import type { LibraryFile, LibraryItem } from '../model';
import { PROVIDER_META, statusLabel } from '../model';
import { isSafeExternalUrl, magnetForHash } from '../validation';
import type { RootStackParamList } from '../navigation';
import { useAppTheme } from '../theme';
import { EmptyState, ErrorBanner, FilterButton, Icon, ProviderBadge, Screen, styles, type IconName } from '../ui';
import { confirmNativeAction } from '../confirmAction';

type Props = NativeStackScreenProps<RootStackParamList, 'Detail'>;

export function DetailScreen({ route, navigation }: Props) {
	const theme = useAppTheme();
	const { snapshot, detail, openFile, remove, selectFiles, reinsert } = useApp();
	const original = snapshot.items.find((entry) => entry.id === route.params.itemId);
	const connectionKey = original ? `${original.provider}:${original.id}` : '';
	const connectionKeyRef = useRef(connectionKey);
	const mountedRef = useRef(true);
	const [item, setItem] = useState<LibraryItem | undefined>(original);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState('');
	const [action, setAction] = useState('');
	const [selectedIds, setSelectedIds] = useState<string[]>([]);

	useEffect(() => {
		connectionKeyRef.current = connectionKey;
	}, [connectionKey]);

	useEffect(() => () => {
		mountedRef.current = false;
	}, []);

	useEffect(() => {
		let active = true;
		setLoading(true);
		void (async () => {
			if (!original) {
				if (active) {
					setItem(undefined);
					setError('This library item is no longer connected.');
					setLoading(false);
				}
				return;
			}
			try {
				const refreshed = await detail(original.provider, original.id);
				if (active) {
					setItem(refreshed);
					setSelectedIds(refreshed.files.filter((file) => file.selected).map((file) => file.id));
				}
			} catch (caught) {
				if (active) setError(caught instanceof Error ? caught.message : 'Could not load item details.');
			} finally {
				if (active) setLoading(false);
			}
		})();
		return () => {
			active = false;
		};
	}, [detail, original?.id, original?.provider]);

	const shareMagnet = () => {
		if (!item?.hash) {
			Alert.alert('Magnet unavailable', 'This item has no valid BTIH.');
			return;
		}
		try {
			void Share.share({ message: magnetForHash(item.hash, item.title) }).catch(() => Alert.alert('Magnet unavailable', 'The native share sheet could not open.'));
		} catch {
			Alert.alert('Magnet unavailable', 'This item has no valid BTIH.');
		}
	};

	const open = async (file: LibraryFile) => {
		if (!item) return;
		setError('');
		setAction(`open:${file.id}`);
		const expectedConnection = connectionKey;
		try {
			const url = await openFile(item.provider, item, file.id);
			if (!mountedRef.current || connectionKeyRef.current !== expectedConnection) throw new Error('Connection changed while opening this file.');
			if (!isSafeExternalUrl(url)) throw new Error('The provider returned an unsafe file URL.');
			await openFileLink(url, file.name);
		} catch (caught) {
			if (mountedRef.current) setError(caught instanceof Error ? caught.message : 'Could not open this file.');
		} finally {
			if (mountedRef.current) setAction('');
		}
	};

	const confirmDelete = () => {
		if (!item) return;
		confirmNativeAction('Delete?', `Remove “${item.title}” from ${PROVIDER_META[item.provider].label}?`, () => {
			setAction('delete');
			// Back to the library once it is gone; the "Item removed" state stays for a screen left open elsewhere.
			void remove(item.provider, item.id).then(() => { setItem(undefined); if (mountedRef.current && navigation.canGoBack()) navigation.goBack(); }).catch((caught) => setError(caught instanceof Error ? caught.message : 'Could not remove this item.')).finally(() => setAction(''));
		});
	};

	const confirmReinsert = () => {
		if (!item) return;
		const what = item.provider === 'rd' ? 'Re-adds it to Real-Debrid with the same files and removes this copy.' : item.provider === 'tb' ? 'Asks TorBox to reannounce this torrent.' : 'Asks AllDebrid to restart this magnet.';
		confirmNativeAction('Reinsert?', what, () => {
			setError('');
			setAction('reinsert');
			void reinsert(item)
				.then(() => { if (mountedRef.current && item.provider === 'rd') navigation.goBack(); })
				.catch((caught) => mountedRef.current && setError(caught instanceof Error ? caught.message : 'Could not reinsert this item.'))
				.finally(() => mountedRef.current && setAction(''));
		}, 'Reinsert');
	};

	const shareHashlist = () => {
		if (!item?.hash) {
			Alert.alert('Hash list unavailable', 'This item has no info hash.');
			return;
		}
		void Share.share({ message: hashlistUrl(item.title, [item]) });
	};

	/** Resolves every file's download link on demand and hands them to the share sheet. */
	const shareAllLinks = async () => {
		if (!item) return;
		setError('');
		const links: string[] = [];
		const failures: string[] = [];
		// Only selected Real-Debrid files have links; the others would each report an error.
		const files = item.provider === 'rd' ? item.files.filter((file) => file.selected) : item.files;
		for (const [index, file] of files.entries()) {
			setAction(`links:${index + 1}/${files.length}`);
			try {
				const url = await openFile(item.provider, item, file.id);
				if (isSafeExternalUrl(url)) links.push(url);
			} catch (caught) {
				failures.push(`${file.name}: ${caught instanceof Error ? caught.message : 'no link'}`);
			}
			if (!mountedRef.current) return;
		}
		setAction('');
		if (failures.length) setError(failures.slice(0, 5).join('\n'));
		if (links.length) void Share.share({ message: links.join('\n') });
	};

	const toggleSelected = (file: LibraryFile) => {
		setSelectedIds((current) => current.includes(file.id) ? current.filter((id) => id !== file.id) : [...current, file.id]);
	};

	const saveSelection = async () => {
		if (!item || selectedIds.length === 0) return;
		setError('');
		setAction('select');
		try {
			if (!item.needsFileSelection) {
				// A torrent past file selection takes a new selection only by being re-added (DMM web's Save).
				await reinsert(item, selectedIds);
				// The old row is gone; the re-added copy is a new item in the library.
				if (mountedRef.current) navigation.goBack();
				return;
			}
			await selectFiles(item, item.files.filter((file) => selectedIds.includes(file.id)));
			// Real-Debrid moves on from waiting_files_selection once files are chosen; show that, not the old row.
			const refreshed = await detail(item.provider, item.id);
			if (mountedRef.current) setItem(refreshed);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : 'Could not select files.');
		} finally {
			setAction('');
		}
	};

	const actionButton = (icon: IconName, label: string, accessibilityLabel: string, onPress: () => void, disabled = false, color = theme.accent) => (
		<Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} onPress={onPress} disabled={disabled} style={[styles.outlineButton, { flexDirection: 'row', alignItems: 'center', gap: 5, borderColor: color, opacity: disabled ? 0.55 : 1 }]}>
			<Icon name={icon} size={16} color={color} />
			<Text style={[styles.outlineButtonText, { color }]}>{label}</Text>
		</Pressable>
	);
	const canSelect = item?.provider === 'rd';
	const selectionChanged = item ? [...selectedIds].sort().join(',') !== item.files.filter((file) => file.selected).map((file) => file.id).sort().join(',') : false;

	if (!item) return <Screen edges={['bottom']}><EmptyState title="Item removed" detail="Return to the library to see the latest provider state." /></Screen>;
	if (loading && !item.filesLoaded) return <Screen edges={['bottom']}><View style={styles.empty}><ActivityIndicator color={theme.accent} /><Text style={[styles.emptyDetail, { color: theme.muted }]}>Loading provider details…</Text></View></Screen>;

	return (
		<Screen edges={['bottom']}>
			<ScrollView contentContainerStyle={styles.content}>
				<ProviderBadge provider={item.provider} />
				<Text style={[styles.detailTitle, { color: theme.text }]}>{item.title}</Text>
				<Text style={[styles.detailMeta, { color: theme.muted }]}>{statusLabel(item.status)} · {Math.round(item.progress)}% · {formatBytes(item.size)}</Text>
				<Text style={[styles.detailMeta, { color: theme.muted }]}>{item.serviceStatus}</Text>
				<View style={[styles.row, { marginTop: 16, flexWrap: 'wrap' }]}>
					{actionButton('share-variant', 'Magnet', 'Share item magnet', shareMagnet)}
					{actionButton('format-list-bulleted', 'Hash list', 'Share hash list link', shareHashlist)}
					{item.files.length > 0 ? actionButton('link-variant', action.startsWith('links:') ? `Links ${action.slice(6)}…` : 'Links', 'Share all file links', () => void shareAllLinks(), Boolean(action)) : null}
					{item.reinsertable ? actionButton('restore', action === 'reinsert' ? 'Reinserting…' : 'Reinsert', 'Reinsert item', confirmReinsert, Boolean(action)) : null}
					{actionButton('delete-outline', action === 'delete' ? 'Deleting…' : 'Delete', 'Delete item', confirmDelete, action === 'delete', theme.danger)}
				</View>
				{error ? <ErrorBanner message={error} /> : null}
				<View style={styles.detailSection}>
					<View style={styles.rowBetween}><Text style={[styles.accountTitle, { color: theme.text }]}>Files</Text><Text style={[styles.detailMeta, { color: theme.muted }]}>{item.files.length}</Text></View>
					{canSelect && item.files.length > 0 ? <View style={[styles.modalButtonRow, { marginTop: 8 }]}>
						<FilterButton label="Select all" active={false} onPress={() => setSelectedIds(item.files.map((file) => file.id))} />
						<FilterButton label="Unselect all" active={false} onPress={() => setSelectedIds([])} />
						<FilterButton label="Only videos" active={false} onPress={() => setSelectedIds(item.files.filter((file) => isVideoName(file.name)).map((file) => file.id))} />
						<FilterButton label="Reset" active={false} onPress={() => setSelectedIds(item.files.filter((file) => file.selected).map((file) => file.id))} />
					</View> : null}
					{item.files.length === 0 ? <EmptyState title="No files reported yet" detail="Refresh after the provider finishes preparing this item." /> : item.files.map((file) => {
						const selected = selectedIds.includes(file.id);
						return <View key={file.id} style={[styles.fileRow, { borderBottomColor: theme.border }]}>
							{canSelect ? <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: selected }} accessibilityLabel={`Select ${file.name}`} onPress={() => toggleSelected(file)} style={[styles.outlineButton, { borderColor: selected ? theme.accent : theme.border, backgroundColor: selected ? theme.accent : 'transparent' }]}><Icon name={selected ? 'check' : 'checkbox-blank-outline'} size={18} color={selected ? theme.onAccent : theme.muted} /></Pressable> : null}
							<Text numberOfLines={2} style={[styles.fileName, { color: theme.text }]}>{file.name}</Text>
							<Text numberOfLines={1} style={[styles.fileSize, { color: theme.muted }]}>{formatBytes(file.size)}</Text>
							<Pressable accessibilityRole="button" accessibilityLabel={`Open ${file.name}`} onPress={() => void open(file)} disabled={action === `open:${file.id}`} style={[styles.fileButton, { backgroundColor: theme.accent, opacity: action === `open:${file.id}` ? 0.55 : 1 }]}><Text style={[styles.fileButtonText, { color: theme.onAccent }]}>{action === `open:${file.id}` ? 'Opening…' : 'Open'}</Text></Pressable>
						</View>;
					})}
					{canSelect ? <Pressable accessibilityRole="button" accessibilityLabel="Select files for Real-Debrid" onPress={() => void saveSelection()} disabled={action === 'select' || selectedIds.length === 0 || (!item.needsFileSelection && !selectionChanged)} style={[styles.primaryButton, { backgroundColor: theme.accent, opacity: action === 'select' || selectedIds.length === 0 || (!item.needsFileSelection && !selectionChanged) ? 0.55 : 1, marginTop: 14 }]}><Text style={[styles.primaryButtonText, { color: theme.onAccent }]}>{action === 'select' ? 'Selecting…' : item.needsFileSelection ? 'Select files for Real-Debrid' : `Save selection (${selectedIds.length}) and reinsert`}</Text></Pressable> : null}
				</View>
			</ScrollView>
		</Screen>
	);
}
