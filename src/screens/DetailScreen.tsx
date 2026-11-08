import { useEffect, useRef, useState } from 'react';
import {
	ActivityIndicator,
	Alert,
	Linking,
	Pressable,
	ScrollView,
	Share,
	Text,
	View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useApp } from '../AppContext';
import { formatBytes } from '../core';
import type { LibraryFile, LibraryItem } from '../model';
import { PROVIDER_META, statusLabel } from '../model';
import { isSafeExternalUrl, magnetForHash } from '../validation';
import type { RootStackParamList } from '../navigation';
import { useAppTheme } from '../theme';
import { EmptyState, ErrorBanner, ProviderBadge, Screen, styles } from '../ui';
import { confirmNativeAction } from '../confirmAction';

type Props = NativeStackScreenProps<RootStackParamList, 'Detail'>;

export function DetailScreen({ route }: Props) {
	const theme = useAppTheme();
	const { snapshot, detail, openFile, remove, selectFiles } = useApp();
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
			await Linking.openURL(url);
		} catch (caught) {
			if (mountedRef.current) setError(caught instanceof Error ? caught.message : 'Could not open this file.');
		} finally {
			if (mountedRef.current) setAction('');
		}
	};

	const confirmDelete = () => {
		if (!item) return;
		confirmNativeAction('Remove from library?', `Remove “${item.title}” from ${PROVIDER_META[item.provider].label}?`, () => {
			setAction('delete');
			void remove(item.provider, item.id).then(() => setItem(undefined)).catch((caught) => setError(caught instanceof Error ? caught.message : 'Could not remove this item.')).finally(() => setAction(''));
		});
	};

	const toggleSelected = (file: LibraryFile) => {
		setSelectedIds((current) => current.includes(file.id) ? current.filter((id) => id !== file.id) : [...current, file.id]);
	};

	const saveSelection = async () => {
		if (!item || selectedIds.length === 0) return;
		setError('');
		setAction('select');
		try {
			await selectFiles(item, item.files.filter((file) => selectedIds.includes(file.id)));
			setItem((current) => current ? { ...current, needsFileSelection: false } : current);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : 'Could not select files.');
		} finally {
			setAction('');
		}
	};

	if (!item) return <Screen edges={['bottom']}><EmptyState title="Item removed" detail="Return to the library to see the latest provider state." /></Screen>;
	if (loading && !item.filesLoaded) return <Screen edges={['bottom']}><View style={styles.empty}><ActivityIndicator color={theme.accent} /><Text style={[styles.emptyDetail, { color: theme.muted }]}>Loading provider details…</Text></View></Screen>;

	return (
		<Screen edges={['bottom']}>
			<ScrollView contentContainerStyle={styles.content}>
				<ProviderBadge provider={item.provider} />
				<Text style={[styles.detailTitle, { color: theme.text }]}>{item.title}</Text>
				<Text style={[styles.detailMeta, { color: theme.muted }]}>{statusLabel(item.status)} · {Math.round(item.progress)}% · {formatBytes(item.size)}</Text>
				<Text style={[styles.detailMeta, { color: theme.muted }]}>{item.serviceStatus}</Text>
				<View style={[styles.row, { marginTop: 16 }]}>
					<Pressable accessibilityRole="button" accessibilityLabel="Share item magnet" onPress={shareMagnet} style={[styles.outlineButton, { borderColor: theme.accent }]}><Text style={[styles.outlineButtonText, { color: theme.accent }]}>Share magnet</Text></Pressable>
					<Pressable accessibilityRole="button" accessibilityLabel="Remove item" onPress={confirmDelete} disabled={action === 'delete'} style={[styles.outlineButton, { borderColor: theme.danger }]}><Text style={[styles.outlineButtonText, { color: theme.danger }]}>{action === 'delete' ? 'Removing…' : 'Remove'}</Text></Pressable>
				</View>
				{error ? <ErrorBanner message={error} /> : null}
				<View style={styles.detailSection}>
					<View style={styles.rowBetween}><Text style={[styles.accountTitle, { color: theme.text }]}>Files</Text><Text style={[styles.detailMeta, { color: theme.muted }]}>{item.files.length}</Text></View>
					{item.files.length === 0 ? <EmptyState title="No files reported yet" detail="Refresh after the provider finishes preparing this item." /> : item.files.map((file) => {
						const selected = selectedIds.includes(file.id);
						return <View key={file.id} style={[styles.fileRow, { borderBottomColor: theme.border }]}>
							{item.needsFileSelection ? <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: selected }} accessibilityLabel={`Select ${file.name}`} onPress={() => toggleSelected(file)} style={[styles.outlineButton, { borderColor: selected ? theme.accent : theme.border, backgroundColor: selected ? theme.accent : 'transparent' }]}><Text style={{ color: selected ? theme.onAccent : theme.text }}>{selected ? '✓' : '○'}</Text></Pressable> : null}
							<Text numberOfLines={2} style={[styles.fileName, { color: theme.text }]}>{file.name}</Text>
							<Text numberOfLines={1} style={[styles.fileSize, { color: theme.muted }]}>{formatBytes(file.size)}</Text>
							<Pressable accessibilityRole="button" accessibilityLabel={`Open ${file.name}`} onPress={() => void open(file)} disabled={action === `open:${file.id}`} style={[styles.fileButton, { backgroundColor: theme.accent, opacity: action === `open:${file.id}` ? 0.55 : 1 }]}><Text style={[styles.fileButtonText, { color: theme.onAccent }]}>{action === `open:${file.id}` ? 'Opening…' : 'Open'}</Text></Pressable>
						</View>;
					})}
					{item.needsFileSelection ? <Pressable accessibilityRole="button" accessibilityLabel="Select files for Real-Debrid" onPress={() => void saveSelection()} disabled={action === 'select' || selectedIds.length === 0} style={[styles.primaryButton, { backgroundColor: theme.accent, opacity: action === 'select' || selectedIds.length === 0 ? 0.55 : 1, marginTop: 14 }]}><Text style={[styles.primaryButtonText, { color: theme.onAccent }]}>{action === 'select' ? 'Selecting…' : 'Select files for Real-Debrid'}</Text></Pressable> : null}
				</View>
			</ScrollView>
		</Screen>
	);
}
