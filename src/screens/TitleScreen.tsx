import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Alert, Image, Platform, ScrollView, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useApp } from '../AppContext';
import { formatBytes } from '../core';
import type { LibraryFile, LibraryItem } from '../model';
import { PROVIDER_META } from '../model';
import type { RootStackParamList } from '../navigation';
import { openFileLink } from '../player';
import { useAppTheme } from '../theme';
import { mainFile, posterUrls, qualityOf, seasonRange, showEpisodes, smallerTmdb, type EpisodeCopy, type TitleInfo } from '../titles';
import { isSafeExternalUrl } from '../validation';
import { EmptyState, FilterButton, Pressable, Screen, styles, useLayout } from '../ui';

type Props = NativeStackScreenProps<RootStackParamList, 'Title'>;

const SHORT = { rd: 'RD', ad: 'AD', tb: 'TB', pm: 'PM', oc: 'OC', dl: 'DL' } as const;
const fileBase = (name: string) => name.split('/').pop() ?? name;

/** A film's or show's page: what the library holds of it, each copy with Open. Nothing here comes from DMM's search. */
export function TitleScreen({ route, navigation }: Props) {
	const theme = useAppTheme();
	const { wide } = useLayout();
	const edges: Array<'top' | 'bottom'> = Platform.isTV ? ['top', 'bottom'] : ['bottom'];
	const { snapshot, titles, openFile, detail } = useApp();
	const version = useSyncExternalStore(titles.subscribe, titles.getVersion);
	const { imdbId } = route.params;
	const copies = useMemo(
		() => snapshot.items.filter((item) => titles.identification(item)?.imdbId === imdbId),
		// `version`: a copy named after the page opened joins it
		[imdbId, snapshot.items, titles, version]
	);
	const named = copies.map((item) => titles.identification(item)).find(Boolean);
	const kind = named?.kind ?? 'movie';
	const [info, setInfo] = useState<TitleInfo | null>(null);
	const [reading, setReading] = useState('');
	const [opening, setOpening] = useState('');
	const [season, setSeason] = useState<number | 'unplaced' | null>(null);
	const mounted = useRef(true);
	useEffect(() => () => void (mounted.current = false), []);

	useEffect(() => {
		navigation.setOptions({ title: named ? `${named.title}${named.year ? ` (${named.year})` : ''}` : '' });
	}, [named?.title, named?.year, navigation]);

	useEffect(() => {
		void titles.info(imdbId, kind).then((found) => mounted.current && setInfo(found)).catch(() => undefined);
	}, [imdbId, kind, titles]);

	// A show's episodes need each release's file list; the provider is asked once per release, then it is remembered.
	const copyIds = copies.map((item) => item.id).join(',');
	useEffect(() => {
		if (kind !== 'tv' || copies.length === 0) return;
		void titles.loadFiles(copies, (done, total) => mounted.current && setReading(done < total ? `Reading files ${done}/${total}…` : ''));
	}, [copyIds, kind, titles]);

	const episodes = useMemo(
		() => (kind === 'tv' ? showEpisodes(copies.map((item) => ({ item, files: titles.filesOf(item) ?? [], seasons: titles.identification(item)?.seasons })), info?.season_episode_counts) : null),
		[copies, info, kind, titles, version]
	);
	const seasons = episodes ? [...episodes.seasons.keys()] : [];
	const shownSeason = season ?? seasons[0] ?? (episodes?.unplaced.length ? 'unplaced' : null);

	const open = async (key: string, item: LibraryItem, pick: (files: LibraryFile[]) => LibraryFile | undefined) => {
		setOpening(key);
		try {
			const files = titles.filesOf(item) ?? (await detail(item.provider, item.id)).files;
			const file = pick(files);
			if (!file) throw new Error('This copy has no video to open yet.');
			const url = await openFile(item.provider, { ...item, files }, file.id);
			if (!isSafeExternalUrl(url)) throw new Error('The provider returned an unsafe file URL.');
			await openFileLink(url, fileBase(file.name));
		} catch (caught) {
			if (mounted.current) Alert.alert('Could not open the file', caught instanceof Error ? caught.message : 'Could not open this file.');
		} finally {
			if (mounted.current) setOpening('');
		}
	};

	const openButton = (key: string, label: string, onPress: () => void) => (
		<Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} disabled={Boolean(opening)} style={[styles.fileButton, { backgroundColor: theme.accent, opacity: opening && opening !== key ? 0.55 : 1 }]}>
			<Text style={[styles.fileButtonText, { color: theme.onAccent }]}>{opening === key ? 'Opening…' : 'Open'}</Text>
		</Pressable>
	);
	const copyLine = (item: LibraryItem, quality: string, size: number) => {
		const meta = PROVIDER_META[item.provider];
		const state = item.status === 'finished' ? '' : ` · ${Math.round(item.progress)}% ${item.serviceStatus}`;
		return (
			<View style={[styles.row, { flex: 1, gap: 6 }]}>
				<View style={{ backgroundColor: meta.color, borderRadius: 4, paddingHorizontal: 4 }}><Text style={{ fontSize: 10, fontWeight: '800', color: item.provider === 'tb' || item.provider === 'pm' ? '#fff' : '#111827' }}>{SHORT[item.provider]}</Text></View>
				<Text numberOfLines={1} style={{ flex: 1, color: theme.text, fontSize: 13.5 }}>{[quality, formatBytes(size).replace('Unknown size', '')].filter(Boolean).join(' · ')}{state}</Text>
			</View>
		);
	};
	const episodeCopy = (copy: EpisodeCopy, label: string) => {
		const key = `${copy.item.id}/${copy.file.id}`;
		return (
			<View key={key} style={[styles.row, { paddingVertical: 6 }]}>
				{copyLine(copy.item, copy.quality, copy.file.size)}
				{openButton(key, `Open ${label} from ${PROVIDER_META[copy.item.provider].label}`, () => void open(key, copy.item, (files) => files.find((file) => file.id === copy.file.id)))}
			</View>
		);
	};

	if (copies.length === 0) return <Screen edges={edges}><EmptyState title="Not in your library" detail="Its releases were removed or are no longer named." /></Screen>;
	const poster = smallerTmdb(info?.poster, 'w342') ?? posterUrls(imdbId)[0];
	const posterWidth = wide ? 150 : 100;

	return (
		<Screen edges={edges}>
			<ScrollView contentContainerStyle={{ paddingBottom: 36 }}>
				{info?.backdrop ? <Image source={{ uri: smallerTmdb(info.backdrop, 'w1280') }} resizeMode="cover" style={{ width: '100%', height: wide ? 240 : 170, backgroundColor: theme.surface }} accessibilityIgnoresInvertColors /> : <View style={{ height: 16 }} />}
				<View style={[styles.content, wide && styles.contentWide, { paddingTop: 0 }]}>
					<View style={[styles.row, { alignItems: 'flex-end', gap: 14, marginTop: info?.backdrop ? -posterWidth * 0.5 : 0 }]}>
						<Image source={{ uri: poster }} resizeMode="cover" style={{ width: posterWidth, height: posterWidth * 1.5, borderRadius: 8, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border }} accessibilityIgnoresInvertColors />
						<View style={{ flex: 1, paddingBottom: 4 }}>
							<Text style={[styles.detailTitle, { color: theme.text }]}>{named?.title ?? info?.title}</Text>
							<Text style={[styles.detailMeta, { color: theme.muted }]}>
								{[named?.year ?? info?.year, kind === 'tv' ? 'Show' : 'Film', `${copies.length} ${copies.length === 1 ? 'copy' : 'copies'}`].filter(Boolean).join(' · ')}
							</Text>
						</View>
					</View>
					{info?.description ? <Text style={{ color: theme.text, fontSize: 14.5, lineHeight: 21, marginTop: 14 }}>{info.description}</Text> : null}

					{kind === 'movie' ? (
						<View style={styles.detailSection}>
							<Text style={[styles.accountTitle, { color: theme.text, marginBottom: 4 }]}>Your copies</Text>
							{[...copies].sort((a, b) => b.size - a.size).map((item) => (
								<View key={item.id} style={[styles.fileRow, { borderBottomColor: theme.border }]}>
									{copyLine(item, qualityOf(item.filename), item.size)}
									{openButton(item.id, `Open from ${PROVIDER_META[item.provider].label}`, () => void open(item.id, item, (files) => mainFile(item, files)))}
								</View>
							))}
						</View>
					) : (
						<View style={styles.detailSection}>
							<View style={styles.rowBetween}>
								<Text style={[styles.accountTitle, { color: theme.text }]}>Episodes</Text>
								{reading ? <View style={styles.row}><ActivityIndicator color={theme.accent} /><Text style={{ color: theme.muted, fontSize: 12 }}>{reading}</Text></View> : null}
							</View>
							{/* One row however many seasons: South Park's 25 filled a phone's screen. */}
							<ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 10, marginHorizontal: -16 }} contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}>
								{seasons.map((number) => <FilterButton key={number} label={number === 0 ? 'Specials' : `Season ${number}`} active={shownSeason === number} onPress={() => setSeason(number)} />)}
								{episodes?.unplaced.length ? <FilterButton label={`Not placed (${episodes.unplaced.length})`} active={shownSeason === 'unplaced'} onPress={() => setSeason('unplaced')} /> : null}
							</ScrollView>
							{shownSeason === 'unplaced'
								? episodes?.unplaced.map((copy) => (
										<View key={`${copy.item.id}/${copy.file.id}`} style={[{ paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: theme.border }]}>
											<Text numberOfLines={2} style={{ color: theme.text, fontSize: 13.5 }}>{copy.label}</Text>
											{episodeCopy(copy, copy.label)}
										</View>
									))
								: [...(shownSeason === null ? [] : episodes?.seasons.get(shownSeason) ?? new Map<number, EpisodeCopy[]>())].map(([number, list]) => {
										const end = list.find((copy) => copy.ref?.end)?.ref?.end;
										const label = `${shownSeason === 0 ? 'Special' : 'Episode'} ${number}${end ? `–${end}` : ''}`;
										return (
											<View key={number} style={{ paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: theme.border }}>
												<Text style={{ color: theme.text, fontSize: 15, fontWeight: '700' }}>{label}</Text>
												<Text numberOfLines={1} style={{ color: theme.muted, fontSize: 12 }}>{fileBase(list[0].file.name)}</Text>
												{list.map((copy) => episodeCopy(copy, label))}
											</View>
										);
									})}
							{!reading && episodes && seasons.length === 0 && episodes.unplaced.length === 0 ? <EmptyState title="No episodes to open yet" detail="Its releases have no video files the provider lists." /> : null}
						</View>
					)}

					<View style={styles.detailSection}>
						<Text style={[styles.accountTitle, { color: theme.text, marginBottom: 4 }]}>Releases</Text>
						{copies.map((item) => (
							<Pressable key={item.id} accessibilityRole="button" accessibilityLabel={`Details of ${item.title}`} onPress={() => navigation.navigate('Detail', { itemId: item.id })} style={({ pressed, focused }) => [{ paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: theme.border, backgroundColor: pressed || focused ? theme.surface : 'transparent' }]}>
								<Text numberOfLines={2} style={{ color: theme.text, fontSize: 13.5 }}>{item.title}</Text>
								<Text style={{ color: theme.muted, fontSize: 12, marginTop: 2 }}>{[PROVIDER_META[item.provider].label, formatBytes(item.size), kind === 'tv' ? seasonRange(titles.identification(item)?.seasons ?? []) : ''].filter(Boolean).join(' · ')}</Text>
							</Pressable>
						))}
					</View>
				</View>
			</ScrollView>
		</Screen>
	);
}
