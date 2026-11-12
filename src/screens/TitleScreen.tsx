import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Alert, Image, Linking, Platform, ScrollView, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useApp } from '../AppContext';
import { dmmPageUrl } from '../search';
import { simklPage } from '../simkl';
import { DMM_ORIGIN } from '../tvLink';
import { formatBytes } from '../core';
import type { LibraryFile, LibraryItem } from '../model';
import { PROVIDER_META } from '../model';
import type { RootStackParamList } from '../navigation';
import { playback } from '../playback';
import { useAppTheme } from '../theme';
import { mainFile, posterUrls, qualityOf, seasonRange, smallerTmdb, type EpisodeCopy, type TitleInfo } from '../titles';
import { ActionSheet, EmptyState, FilterButton, Icon, Pressable, QrCode, Screen, styles, useLayout, type SheetAction } from '../ui';
import { progressOf, resumable, rowRefs, rowsUpTo, seasonRows, watched, watchKey, type HeldEpisode } from '../watched';
import { useOpenCopy, useWatch } from './hooks';

type Props = NativeStackScreenProps<RootStackParamList, 'Title'>;

const SHORT = { rd: 'RD', ad: 'AD', tb: 'TB', pm: 'PM', oc: 'OC', dl: 'DL' } as const;
const fileBase = (name: string) => name.split('/').pop() ?? name;

/**
 * A film's or show's page: what the library holds of it, each copy with Open. Nothing here comes from DMM's search.
 * A title the library lacks (from a tracker's list) gets what it is and its DMM page: finding releases stays on DMM web.
 */
const idle = () => () => undefined;

export function TitleScreen({ route, navigation }: Props) {
	const theme = useAppTheme();
	const { wide } = useLayout();
	const edges: Array<'top' | 'bottom'> = Platform.isTV ? ['top', 'bottom'] : ['bottom'];
	const { snapshot, titles, simkl } = useApp();
	const simklLinked = Boolean(useSyncExternalStore(simkl ? simkl.account.subscribe : idle, () => simkl?.account.login));
	const openCopy = useOpenCopy();
	const { playVersion } = useWatch();
	const [menu, setMenu] = useState<{ title: string; actions: SheetAction[] } | null>(null);
	const version = useSyncExternalStore(titles.subscribe, titles.getVersion);
	const { imdbId } = route.params;
	const copies = useMemo(
		() => snapshot.items.filter((item) => titles.identification(item)?.imdbId === imdbId),
		// `version`: a copy named after the page opened joins it
		[imdbId, snapshot.items, titles, version]
	);
	const named = copies.map((item) => titles.identification(item)).find(Boolean);
	const kind = named?.kind ?? route.params.kind ?? 'movie';
	const held = copies.length > 0;
	const [info, setInfo] = useState<TitleInfo | null>(null);
	const [reading, setReading] = useState('');
	const [opening, setOpening] = useState('');
	const [season, setSeason] = useState<number | 'unplaced' | null>(null);
	const mounted = useRef(true);
	useEffect(() => () => void (mounted.current = false), []);

	useEffect(() => {
		const { title, year } = named ?? route.params;
		navigation.setOptions({ title: title ? `${title}${year ? ` (${year})` : ''}` : '' });
	}, [named?.title, named?.year, navigation, route.params]);

	useEffect(() => {
		void titles.info(imdbId, kind).then((found) => mounted.current && setInfo(found)).catch(() => undefined);
	}, [imdbId, kind, titles]);

	// A show's episodes need each release's file list; the provider is asked once per release, then it is remembered.
	const copyIds = copies.map((item) => item.id).join(',');
	useEffect(() => {
		if (kind !== 'tv' || copies.length === 0) return;
		void titles.loadFiles(copies, (done, total) => mounted.current && setReading(done < total ? `Reading files ${done}/${total}…` : ''));
	}, [copyIds, kind, titles]);

	// `version`: files read and episode counts fetched since
	const episodes = useMemo(() => (kind === 'tv' ? titles.episodesOf(copies, imdbId) : null), [copies, imdbId, kind, titles, version]);
	const seasons = episodes ? [...episodes.seasons.keys()] : [];
	const shownSeason = season ?? seasons[0] ?? (episodes?.unplaced.length ? 'unplaced' : null);

	// Watched is per title: any copy, any provider. Re-rendered by useWatch on every change.
	const playing = useMemo(() => resumable(playback.list()), [playVersion]);
	const isWatched = (row: Pick<HeldEpisode, 'season' | 'episode'>) => watched.watchedAt({ imdbId, season: row.season, episode: row.episode }) !== undefined;
	const seasonState = (number: number) => {
		const rows = episodes ? seasonRows(episodes, number) : [];
		return { rows, seen: rows.filter(isWatched).length };
	};
	const markSeason = (number: number, watch: boolean) => {
		const { rows } = seasonState(number);
		// Unwatching a season also clears its episodes this library no longer holds.
		const stale = watch ? [] : watched.list().filter((mark) => mark.imdbId === imdbId && mark.season === number);
		void watched.set([...rows.flatMap((row) => rowRefs(imdbId, row)), ...stale], watch);
	};
	const episodeMenu = (row: HeldEpisode, label: string) => {
		const before = rowsUpTo(episodes!, row);
		setMenu({
			title: `${named?.title ?? ''} · ${label}`,
			actions: [
				{ label: isWatched(row) ? 'Mark unwatched' : 'Mark watched', onPress: () => void watched.set(rowRefs(imdbId, row), !isWatched(row)) },
				...(before.length > 1 ? [{ label: 'Mark watched up to here', onPress: () => void watched.set(before.flatMap((other) => rowRefs(imdbId, other)), true) }] : []),
			],
		});
	};
	const filmWatched = watched.watchedAt({ imdbId }) !== undefined;

	const open = async (key: string, item: LibraryItem, pick: (files: LibraryFile[]) => LibraryFile | undefined) => {
		setOpening(key);
		try {
			await openCopy(item, pick);
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
							<Text style={[styles.detailTitle, { color: theme.text }]}>{named?.title ?? info?.title ?? route.params.title}</Text>
							<Text style={[styles.detailMeta, { color: theme.muted }]}>
								{[named?.year ?? info?.year ?? route.params.year, kind === 'tv' ? 'Show' : 'Film', held ? `${copies.length} ${copies.length === 1 ? 'copy' : 'copies'}` : 'Not in your library'].filter(Boolean).join(' · ')}
							</Text>
							{held && kind === 'movie' ? <View style={{ marginTop: 8, alignSelf: 'flex-start' }}><WatchButton watched={filmWatched} label={filmWatched ? 'Watched' : 'Mark watched'} onPress={() => void watched.set([{ imdbId }], !filmWatched)} /></View> : null}
						</View>
						{/* A TV's remote cannot scroll a page with nothing to focus: the code sits beside the poster, in view. */}
						{!held && Platform.isTV ? <OnDmm imdbId={imdbId} kind={kind} /> : null}
					</View>
					{info?.description ? <Text style={{ color: theme.text, fontSize: 14.5, lineHeight: 21, marginTop: 14 }}>{info.description}</Text> : null}
					{/* Simkl's API rules: where its watch history shows, link to the title on Simkl (a TV has no browser). */}
					{simklLinked && !Platform.isTV ? (
						<Pressable accessibilityRole="link" accessibilityLabel="View on Simkl" onPress={() => void Linking.openURL(simklPage(imdbId))} style={{ marginTop: 10, alignSelf: 'flex-start' }}>
							<Text style={{ color: theme.accent, fontSize: 13.5, fontWeight: '700' }}>View on Simkl</Text>
						</Pressable>
					) : null}

					{!held ? (
						Platform.isTV ? null : <OnDmm imdbId={imdbId} kind={kind} />
					) : kind === 'movie' ? (
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
								{typeof shownSeason === 'number' && !reading
									? (() => {
											const { rows, seen } = seasonState(shownSeason);
											const all = rows.length > 0 && seen === rows.length;
											const name = shownSeason === 0 ? 'specials' : 'season';
											return <WatchButton watched={all} label={all ? `Mark ${name} unwatched` : `Mark ${name} watched`} onPress={() => markSeason(shownSeason, !all)} />;
										})()
									: null}
							</View>
							{/* One row however many seasons: South Park's 25 filled a phone's screen. */}
							<ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 10, marginHorizontal: -16 }} contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}>
								{seasons.map((number) => {
									const { rows, seen } = seasonState(number);
									return <FilterButton key={number} label={`${number === 0 ? 'Specials' : `Season ${number}`}${seen && seen < rows.length ? ` · ${seen}/${rows.length}` : ''}`} icon={seen && seen === rows.length ? 'check' : undefined} active={shownSeason === number} onPress={() => setSeason(number)} />;
								})}
								{episodes?.unplaced.length ? <FilterButton label={`Not placed (${episodes.unplaced.length})`} active={shownSeason === 'unplaced'} onPress={() => setSeason('unplaced')} /> : null}
							</ScrollView>
							{shownSeason === 'unplaced'
								? episodes?.unplaced.map((copy) => (
										<View key={`${copy.item.id}/${copy.file.id}`} style={[{ paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: theme.border }]}>
											<Text numberOfLines={2} style={{ color: theme.text, fontSize: 13.5 }}>{copy.label}</Text>
											{episodeCopy(copy, copy.label)}
										</View>
									))
								: (shownSeason === null || !episodes ? [] : seasonRows(episodes, shownSeason)).map((row) => {
										const { episode: number, end, copies: list } = row;
										const label = `${shownSeason === 0 ? 'Special' : 'Episode'} ${number}${end > number ? `–${end}` : ''}`;
										const seen = isWatched(row);
										const progress = progressOf(playing.get(watchKey({ imdbId, season: row.season, episode: number })), watched.watchedAt({ imdbId, season: row.season, episode: number }));
										return (
											<View key={number} style={{ paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: theme.border }}>
												<View style={styles.row}>
													<View style={{ flex: 1 }}>
														<Text style={{ color: theme.text, fontSize: 15, fontWeight: '700' }}>{label}</Text>
														<Text numberOfLines={1} style={{ color: theme.muted, fontSize: 12 }}>{fileBase(list[0].file.name)}</Text>
													</View>
													{/* A tap marks it, a long press offers "up to here". */}
													<Pressable accessibilityRole="checkbox" accessibilityState={{ checked: seen }} accessibilityLabel={`${label} watched`} accessibilityHint="Long press for more" onPress={() => void watched.set(rowRefs(imdbId, row), !seen)} onLongPress={() => episodeMenu(row, label)} hitSlop={6} style={{ width: 44, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' }}>
														<Icon name={seen ? 'check-circle' : 'check-circle-outline'} size={26} color={seen ? theme.accent : theme.muted} />
													</Pressable>
												</View>
												{progress ? <View style={{ height: 3, borderRadius: 2, marginTop: 6, backgroundColor: theme.border }}><View style={{ height: 3, borderRadius: 2, width: `${Math.round(progress * 100)}%`, backgroundColor: theme.accent }} /></View> : null}
												{list.map((copy) => episodeCopy(copy, label))}
											</View>
										);
									})}
							{!reading && episodes && seasons.length === 0 && episodes.unplaced.length === 0 ? <EmptyState title="No episodes to open yet" detail="Its releases have no video files the provider lists." /> : null}
						</View>
					)}

					{held ? <View style={styles.detailSection}>
						<Text style={[styles.accountTitle, { color: theme.text, marginBottom: 4 }]}>Releases</Text>
						{copies.map((item) => (
							<Pressable key={item.id} accessibilityRole="button" accessibilityLabel={`Details of ${item.title}`} onPress={() => navigation.navigate('Detail', { itemId: item.id })} style={({ pressed, focused }) => [{ paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: theme.border, backgroundColor: pressed || focused ? theme.surface : 'transparent' }]}>
								<Text numberOfLines={2} style={{ color: theme.text, fontSize: 13.5 }}>{item.title}</Text>
								<Text style={{ color: theme.muted, fontSize: 12, marginTop: 2 }}>{[PROVIDER_META[item.provider].label, formatBytes(item.size), kind === 'tv' ? seasonRange(titles.identification(item)?.seasons ?? []) : ''].filter(Boolean).join(' · ')}</Text>
							</Pressable>
						))}
					</View> : null}
				</View>
			</ScrollView>
			{menu ? <ActionSheet title={menu.title} actions={menu.actions} onClose={() => setMenu(null)} /> : null}
		</Screen>
	);
}

/**
 * Where a title the library lacks is found: its DMM page, opened in the browser signed in as the app (Search's handoff).
 * A TV has no browser: a QR code of the plain page for a phone, never with a handoff code, which would sign that phone in
 * with the TV's logins.
 */
function OnDmm({ imdbId, kind }: { imdbId: string; kind: 'movie' | 'tv' }) {
	const theme = useAppTheme();
	const { browserState } = useApp();
	const [opening, setOpening] = useState(false);
	const path = `/${kind === 'tv' ? 'show' : 'movie'}/${imdbId}`;
	const open = async () => {
		setOpening(true);
		try {
			await Linking.openURL(await dmmPageUrl(path, await browserState()));
		} catch (error) {
			Alert.alert('Could not open DMM', error instanceof Error ? error.message : String(error));
		} finally {
			setOpening(false);
		}
	};
	if (Platform.isTV) {
		return (
			<View style={{ width: 200, alignItems: 'center', gap: 6 }}>
				<QrCode value={`${DMM_ORIGIN}${path}`} size={160} />
				<Text style={{ color: theme.muted, fontSize: 12.5, textAlign: 'center' }}>Scan to open it on DMM with your phone; what you add there shows up here.</Text>
			</View>
		);
	}
	return (
		<View style={[styles.detailSection, { gap: 10 }]}>
			<Text style={{ color: theme.muted, fontSize: 13.5, lineHeight: 19 }}>Not in your library. Its releases are on DMM: add one there and it shows up here.</Text>
			<Pressable accessibilityRole="link" accessibilityLabel="Open on DMM" onPress={() => void open()} disabled={opening} style={[styles.primaryButton, { backgroundColor: theme.accent, alignSelf: 'flex-start', opacity: opening ? 0.6 : 1 }]}>
				<Text style={[styles.primaryButtonText, { color: theme.onAccent }]}>{opening ? 'Opening…' : 'Open on DMM'}</Text>
			</Pressable>
		</View>
	);
}

/** A film's or a season's watched mark: outlined until watched, then filled. */
function WatchButton({ watched: on, label, onPress }: { watched: boolean; label: string; onPress: () => void }) {
	const theme = useAppTheme();
	return (
		<Pressable accessibilityRole="button" accessibilityState={{ checked: on }} accessibilityLabel={label} onPress={onPress} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, height: 34, paddingHorizontal: 12, borderRadius: 17, borderWidth: 1, borderColor: theme.accent, backgroundColor: on ? theme.accent : 'transparent' }}>
			<Icon name={on ? 'check-circle' : 'check-circle-outline'} size={18} color={on ? theme.onAccent : theme.accent} />
			<Text style={{ color: on ? theme.onAccent : theme.accent, fontSize: 13.5, fontWeight: '700' }}>{label}</Text>
		</Pressable>
	);
}
