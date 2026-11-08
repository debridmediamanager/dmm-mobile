import { useMemo, useState } from 'react';
import {
	ActivityIndicator,
	Alert,
	FlatList,
	KeyboardAvoidingView,
	Modal,
	Platform,
	Pressable,
	RefreshControl,
	ScrollView,
	Share,
	Text,
	TextInput,
	View,
} from 'react-native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useApp } from '../AppContext';
import { filterAndSortLibrary, transferItems } from '../core';
import type { LibraryItem, LibraryStatus, ProviderId, SortMode } from '../model';
import { PROVIDERS, PROVIDER_META } from '../model';
import { magnetForHash, parseBtihMagnet } from '../validation';
import type { RootStackParamList } from '../navigation';
import { useAppTheme } from '../theme';
import { EmptyState, ErrorBanner, FilterButton, LibraryCard, Screen, styles } from '../ui';

type Navigation = NativeStackNavigationProp<RootStackParamList, 'Main'>;

const statuses: Array<LibraryStatus | 'all'> = ['all', 'waiting', 'downloading', 'finished', 'error'];
const sortModes: SortMode[] = ['newest', 'title', 'size'];

export function LibraryScreen({ navigation }: { navigation: Navigation }) {
	return <LibraryListScreen navigation={navigation} transfersOnly={false} />;
}

export function TransfersScreen({ navigation }: { navigation: Navigation }) {
	return <LibraryListScreen navigation={navigation} transfersOnly />;
}

function LibraryListScreen({ navigation, transfersOnly }: { navigation: Navigation; transfersOnly: boolean }) {
	const theme = useAppTheme();
	const { ready, startupError, snapshot, refreshAll, retryStartup } = useApp();
	const [search, setSearch] = useState('');
	const [provider, setProvider] = useState<ProviderId | 'all'>('all');
	const [status, setStatus] = useState<LibraryStatus | 'all'>('all');
	const [sort, setSort] = useState<SortMode>('newest');
	const [adding, setAdding] = useState(false);
	const baseItems = transfersOnly ? transferItems(snapshot.items) : snapshot.items;
	const items = useMemo(
		() => filterAndSortLibrary(baseItems, { search, provider, status, sort }),
		[baseItems, provider, search, sort, status]
	);
	const connectedProviders = PROVIDERS.filter((id) => snapshot.connected[id]);
	const refreshing = Object.values(snapshot.loading).some(Boolean);

	const shareItem = (item: LibraryItem) => {
		try {
			void Share.share({ message: magnetForHash(item.hash, item.title) }).catch(() => Alert.alert('Magnet unavailable', 'The native share sheet could not open.'));
		} catch {
			Alert.alert('Magnet unavailable', 'This provider item has no valid BTIH to share.');
		}
	};

	return (
		<Screen>
			<View style={styles.header}>
				<View style={styles.rowBetween}>
					<View style={{ flex: 1 }}>
						<Text style={[styles.heading, { color: theme.text }]}>{transfersOnly ? 'Transfers' : 'Library'}</Text>
						<Text style={[styles.subheading, { color: theme.muted }]}>{snapshot.items.length} item{snapshot.items.length === 1 ? '' : 's'} across connected providers</Text>
					</View>
					<Pressable accessibilityRole="button" accessibilityLabel={`Refresh ${transfersOnly ? 'transfers' : 'library'}`} onPress={() => void refreshAll()} disabled={refreshing} style={[styles.outlineButton, { borderColor: theme.accent, opacity: refreshing ? 0.55 : 1 }]}><Text style={[styles.outlineButtonText, { color: theme.accent }]}>{refreshing ? 'Refreshing…' : 'Refresh'}</Text></Pressable>
					{!transfersOnly ? <Pressable accessibilityRole="button" accessibilityLabel="Add magnet" onPress={() => setAdding(true)} style={[styles.primaryButton, { backgroundColor: theme.accent }]}><Text style={[styles.primaryButtonText, { color: theme.onAccent }]}>Add magnet</Text></Pressable> : null}
				</View>
				<TextInput
					accessibilityLabel="Search library"
					value={search}
					onChangeText={setSearch}
					placeholder="Search title or filename"
					placeholderTextColor={theme.muted}
					style={[styles.search, { backgroundColor: theme.input, borderColor: theme.border, color: theme.text }]}
				/>
			</View>
			<ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filterBar} contentContainerStyle={styles.filterScroll}>
				<FilterButton label="All providers" active={provider === 'all'} onPress={() => setProvider('all')} />
				{connectedProviders.map((id) => <FilterButton key={id} label={PROVIDER_META[id].label} active={provider === id} onPress={() => setProvider(id)} />)}
			</ScrollView>
			<ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filterBar} contentContainerStyle={styles.filterScroll}>
				{statuses.map((value) => <FilterButton key={value} label={value === 'all' ? 'All statuses' : value[0].toUpperCase() + value.slice(1)} active={status === value} onPress={() => setStatus(value)} />)}
				{sortModes.map((value) => <FilterButton key={value} label={`Sort: ${value}`} active={sort === value} onPress={() => setSort(value)} />)}
			</ScrollView>
			{startupError ? <ErrorBanner message={`Secure account storage: ${startupError}`} actionLabel="Retry secure account load" onAction={() => void retryStartup()} busy={!ready} /> : null}
			{snapshot.failures.length > 0 ? <ErrorBanner message={snapshot.failures.map((failure) => `${PROVIDER_META[failure.provider].label}: ${failure.message}`).join('\n')} actionLabel="Retry library" onAction={() => void refreshAll()} busy={refreshing} /> : null}
			{!ready ? <EmptyState title="Unlocking secure accounts…" detail="Provider credentials are read from the device secure store." /> : items.length === 0 ? (
				<View>
					<EmptyState
						title={refreshing ? 'Loading library…' : snapshot.items.length === 0 ? (connectedProviders.length === 0 ? 'Connect a provider to start' : transfersOnly ? 'No active transfers' : 'Your library is empty') : 'No matching items'}
						detail={snapshot.items.length === 0 && connectedProviders.length === 0 ? 'Open Accounts to validate a provider API key.' : undefined}
					/>
					<Pressable accessibilityRole="button" accessibilityLabel={`Retry ${transfersOnly ? 'transfers' : 'library'}`} onPress={() => void refreshAll()} disabled={refreshing} style={[styles.primaryButton, { alignSelf: 'center', backgroundColor: theme.accent, opacity: refreshing ? 0.55 : 1 }]}><Text style={[styles.primaryButtonText, { color: theme.onAccent }]}>{refreshing ? 'Refreshing…' : 'Refresh library'}</Text></Pressable>
				</View>
			) : (
				<FlatList
					data={items}
					keyExtractor={(item) => item.id}
					renderItem={({ item }) => <LibraryCard item={item} onPress={() => navigation.navigate('Detail', { itemId: item.id })} onShare={() => shareItem(item)} />}
					refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refreshAll()} tintColor={theme.accent} />}
					contentContainerStyle={{ paddingVertical: 6, paddingBottom: 30 }}
				/>
			)}
			{adding ? <AddMagnetModal connectedProviders={connectedProviders} onClose={() => setAdding(false)} /> : null}
		</Screen>
	);
}

function AddMagnetModal({ connectedProviders, onClose }: { connectedProviders: ProviderId[]; onClose: () => void }) {
	const theme = useAppTheme();
	const { add } = useApp();
	const [provider, setProvider] = useState<ProviderId | null>(connectedProviders[0] ?? null);
	const [magnet, setMagnet] = useState('');
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);
	const submit = async () => {
		setError('');
		if (!provider) {
			setError('Connect a provider in Accounts first.');
			return;
		}
		let parsed: ReturnType<typeof parseBtihMagnet>;
		try {
			parsed = parseBtihMagnet(magnet);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : 'Enter a valid magnet.');
			return;
		}
		setBusy(true);
		try {
			await add(provider, parsed.magnet);
			onClose();
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : 'The provider rejected this magnet.');
		} finally {
			setBusy(false);
		}
	};
	return (
		<Modal visible animationType="slide" transparent onRequestClose={onClose}>
			<KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.modalBackdrop}>
				<ScrollView keyboardShouldPersistTaps="handled" style={[styles.modalSheet, { backgroundColor: theme.surface, maxHeight: '90%', width: '100%' }]} contentContainerStyle={{ gap: 12 }}>
					<View style={styles.rowBetween}><Text style={[styles.modalTitle, { color: theme.text }]}>Add to library</Text><Pressable accessibilityRole="button" accessibilityLabel="Close add magnet" onPress={onClose}><Text style={{ color: theme.accent, fontWeight: '700' }}>Close</Text></Pressable></View>
					<Text style={[styles.subheading, { color: theme.muted }]}>Choose one connected provider.</Text>
					<View style={styles.modalButtonRow}>{connectedProviders.map((id) => <FilterButton key={id} label={PROVIDER_META[id].label} active={provider === id} onPress={() => setProvider(id)} />)}</View>
					<TextInput accessibilityLabel="Magnet link" value={magnet} onChangeText={setMagnet} placeholder="magnet:?xt=urn:btih:…" placeholderTextColor={theme.muted} autoCapitalize="none" autoCorrect={false} multiline style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.text, minHeight: 70 }]} />
					{error ? <Text style={[styles.inlineError, { color: theme.danger }]}>{error}</Text> : null}
					<Pressable accessibilityRole="button" accessibilityLabel="Submit magnet" onPress={() => void submit()} disabled={busy || !magnet.trim()} style={[styles.primaryButton, { backgroundColor: theme.accent, opacity: busy || !magnet.trim() ? 0.55 : 1 }]}>{busy ? <ActivityIndicator color={theme.onAccent} /> : <Text style={[styles.primaryButtonText, { color: theme.onAccent }]}>Validate and add</Text>}</Pressable>
				</ScrollView>
			</KeyboardAvoidingView>
		</Modal>
	);
}
