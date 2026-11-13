import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Alert, FlatList, Platform, RefreshControl, ScrollView, Text, TVFocusGuideView, View, type ScrollViewInstance } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useApp } from '../AppContext';
import { filePath } from '../core';
import type { LibraryFile, LibraryItem } from '../model';
import { PROVIDER_META } from '../model';
import type { RootStackParamList } from '../navigation';
import { playback } from '../playback';
import { useAppTheme } from '../theme';
import { timeLabel, dayLabel, dayStart } from '../calendar';
import { episodeCode, groupTitles, mainFile, pickCopy, seasonRange } from '../titles';
import { ActionSheet, EmptyState, ErrorBanner, IconButton, Pressable, Screen, styles, useLayout, type SheetAction } from '../ui';
import { watchlist } from '../lists';
import { continueWatching, nextUp, releaseFinder, remoteResumes, resumable, rowRefs, titleStates, watched, watchKey, type NextUp, type RemotePlayback, type WatchRef } from '../watched';
import { useCalendar, useOpenCopy, useTrackerLists, useWatch } from './hooks';
import { entryCard } from './ListsScreen';
import { PosterCard } from './TitlesView';

const GAP = 10;
const idle = () => () => undefined;
const zero = () => 0;
/** Newest titles in Recently Added. */
const RECENT = 20;
/** Shows in Upcoming, each with its next episode. */
const UPCOMING = 10;

interface Card {
	key: string;
	/** When it was left, for Continue Watching's order. */
	at?: number;
	imdbId?: string;
	title: string;
	detail: string;
	label: string;
	watched?: boolean;
	progress?: number;
	/** A watchlist title the library does not hold. */
	dim?: boolean;
	open: () => void;
	/** Long press: its menu, if it has one. */
	actions: SheetAction[];
}

/**
 * The first tab, a board of poster rows like Stremio's: Continue Watching (files left part way),
 * Next Up (the next episode of each show being watched), the trackers' Watchlist and Recently Added.
 * Only the library plays; a watchlist title it lacks opens what it is and where to find it on DMM.
 */
export function HomeScreen() {
	const theme = useAppTheme();
	const { wide } = useLayout();
	const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
	const { ready, startupError, snapshot, titles, refreshAll, retryStartup, trakt, simkl, trackers } = useApp();
	const version = useSyncExternalStore(titles.subscribe, titles.getVersion);
	const traktVersion = useSyncExternalStore(trakt ? trakt.subscribe : idle, trakt ? trakt.getVersion : zero);
	const simklVersion = useSyncExternalStore(simkl ? simkl.subscribe : idle, simkl ? simkl.getVersion : zero);
	const { watchVersion, playVersion } = useWatch();
	const trackerLists = useTrackerLists();
	const { episodes } = useCalendar();
	const openCopy = useOpenCopy();
	const [opening, setOpening] = useState('');
	const [menu, setMenu] = useState<Card | null>(null);
	// A remote moving up into a row shows its title too: the platform scrolls only the focused card into view.
	const scroller = useRef<ScrollViewInstance>(null);
	const shelfTop = useRef<Record<string, number>>({});
	const scrolled = useRef(0);
	const refreshing = Object.values(snapshot.loading).some(Boolean);
	const cardWidth = wide ? 130 : 112;

	// The versions are the stores' change signals.
	const groups = useMemo(() => groupTitles(snapshot.items, (item) => titles.identification(item)).titles, [snapshot.items, titles, version]);
	const board = useMemo(() => {
		const byId = new Map(groups.map((group) => [group.imdbId, group]));
		const marks = watched.list();
		const entries = playback.list();
		// A show's next episode plays from the release it was last played from, when that has it.
		const find = releaseFinder(snapshot.items);
		const lastPlayed = new Map<string, LibraryItem>();
		for (const [key, entry] of [...entries].sort(([, a], [, b]) => a.updatedAt - b.updatedAt)) {
			const found = entry.imdbId ? find(key) : undefined;
			if (found && entry.imdbId) lastPlayed.set(entry.imdbId, found.item);
		}
		// Left part way on another device (Trakt, Simkl): newer than anything played here, so it replaces this device's row.
		const unread: string[] = [];
		const away = remoteResumes(entries, trackers.flatMap((tracker) => tracker.playback()), (imdbId) => byId.has(imdbId), (ref) => watched.watchedAt(ref)).flatMap((point) => {
			const group = byId.get(point.imdbId)!;
			const before = lastPlayed.get(point.imdbId);
			if (point.season === undefined) {
				const item = group.kind === 'movie' ? (before ?? group.items.find((copy) => copy.status === 'finished')) : undefined;
				return item ? [{ point, item, pick: (files: LibraryFile[]) => mainFile(item, files) }] : [];
			}
			const copies = titles.episodesOf(group.items, point.imdbId).seasons.get(point.season)?.get(point.episode!);
			if (!copies?.length) {
				unread.push(point.imdbId);
				return [];
			}
			const copy = pickCopy(copies, before);
			return [{ point, item: copy.item, pick: (files: LibraryFile[]) => files.find((file) => file.id === copy.file.id) }];
		});
		const elsewhere = new Set(away.map(({ point }) => point.imdbId));
		const resume = continueWatching(entries, snapshot.items, (ref) => watched.watchedAt(ref)).filter(({ entry }) => !entry.imdbId || !elsewhere.has(entry.imdbId));
		const resuming = new Set([
			...resume.map(({ entry }) => (entry.imdbId && entry.season !== undefined ? watchKey({ imdbId: entry.imdbId, season: entry.season, episode: entry.episode }) : '')),
			...away.map(({ point }) => watchKey(point)),
		]);
		const next = [...new Set(marks.filter((mark) => mark.season).map((mark) => mark.imdbId))]
			.map((imdbId) => {
				const group = byId.get(imdbId);
				return group?.kind === 'tv' ? nextUp(imdbId, titles.episodesOf(group.items, imdbId), marks, lastPlayed.get(imdbId)) : null;
			})
			// An episode already in Continue Watching is not listed twice.
			.filter((up): up is NextUp => up !== null && !resuming.has(watchKey({ imdbId: up.imdbId, season: up.row.season, episode: up.row.episode })))
			.sort((a, b) => b.after - a.after);
		const recent = groups.slice(0, RECENT);
		const states = titleStates(recent, (group) => titles.episodesOf(group.items, group.imdbId), marks, resumable(entries));
		return { byId, resume, away, unread, next, recent, states };
	}, [groups, snapshot.items, titles, trackers, version, watchVersion, playVersion, traktVersion, simklVersion]);

	// Finding another device's episode takes the show's file lists, which Real-Debrid does not list: read them once.
	const reading = useRef(new Set<string>());
	useEffect(() => {
		for (const imdbId of board.unread) {
			if (reading.current.has(imdbId)) continue;
			reading.current.add(imdbId);
			void titles.loadFiles(board.byId.get(imdbId)!.items).catch(() => undefined);
		}
	}, [board, titles]);

	const run = (key: string, action: () => Promise<void>) => {
		if (opening) return;
		setOpening(key);
		void action()
			.catch((caught) => Alert.alert('Could not open the file', caught instanceof Error ? caught.message : 'Could not open this file.'))
			.finally(() => setOpening(''));
	};
	const goTo = (imdbId: string) => navigation.navigate('Title', { imdbId });

	const resumeCards: Card[] = board.resume.map(({ key, entry, item, path }) => {
		const group = entry.imdbId ? board.byId.get(entry.imdbId) : undefined;
		const title = group?.title ?? entry.name;
		const code = entry.season !== undefined && entry.episode !== undefined ? episodeCode(entry.season, entry.episode, entry.end) : '';
		const refs: WatchRef[] = !entry.imdbId ? [] : code ? rowRefs(entry.imdbId, { season: entry.season!, episode: entry.episode!, end: entry.end ?? entry.episode! }) : entry.kind === 'tv' ? [] : [{ imdbId: entry.imdbId }];
		return {
			key,
			at: entry.updatedAt,
			imdbId: entry.imdbId,
			title,
			detail: [code, `${Math.max(1, Math.round((entry.duration - entry.position) / 60_000))} min left`].filter(Boolean).join(' · '),
			label: `Resume ${title}${code ? ` ${code}` : ''}`,
			progress: entry.position / entry.duration,
			open: () => run(key, () => openCopy(item, (files) => files.find((file) => filePath(file.name, file.path) === path), true)),
			actions: [
				{
					label: 'Remove from Continue Watching',
					onPress: () => {
						void playback.forget(key);
						// The trackers have this pause too (it was scrobbled): gone there as well, or it would come back from another device.
						const ref = entry.season !== undefined ? { imdbId: entry.imdbId!, season: entry.season, episode: entry.episode } : { imdbId: entry.imdbId! };
						if (entry.imdbId) trackers.forEach((tracker) => tracker.forget(ref));
					},
				},
				...(refs.length ? [{ label: 'Mark watched', onPress: () => void watched.set(refs, true) }] : []),
				...(group ? [{ label: group.kind === 'tv' ? 'Go to show' : 'Go to film', onPress: () => goTo(group.imdbId) }] : []),
			],
		};
	});
	const awayCards: Card[] = board.away.map(({ point, item, pick }: { point: RemotePlayback; item: LibraryItem; pick: (files: LibraryFile[]) => LibraryFile | undefined }) => {
		const group = board.byId.get(point.imdbId)!;
		const code = point.season !== undefined ? episodeCode(point.season, point.episode!) : '';
		const key = `remote:${watchKey(point)}`;
		return {
			key,
			at: point.pausedAt,
			imdbId: point.imdbId,
			title: group.title,
			detail: [code, `${Math.round(point.progress)}% watched`].filter(Boolean).join(' · '),
			label: `Resume ${group.title}${code ? ` ${code}` : ''}`,
			progress: point.progress / 100,
			open: () => run(key, () => openCopy(item, pick, true)),
			actions: [
				{ label: 'Remove from Continue Watching', onPress: () => trackers.forEach((tracker) => tracker.forget(point)) },
				{ label: 'Mark watched', onPress: () => void watched.set([point], true) },
				{ label: group.kind === 'tv' ? 'Go to show' : 'Go to film', onPress: () => goTo(group.imdbId) },
			],
		};
	});
	const continueCards = [...resumeCards, ...awayCards].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
	const nextCards: Card[] = board.next.map(({ imdbId, row, copy }) => {
		const title = board.byId.get(imdbId)?.title ?? '';
		const code = episodeCode(row.season, row.episode, row.end);
		const key = `next:${imdbId}`;
		return {
			key,
			imdbId,
			title,
			detail: `${code} · ${PROVIDER_META[copy.item.provider].label}`,
			label: `Play ${title} ${code}`,
			open: () => run(key, () => openCopy(copy.item, (files) => files.find((file) => file.id === copy.file.id))),
			actions: [
				{ label: `Mark ${code} watched`, onPress: () => void watched.set(rowRefs(imdbId, row), true) },
				{ label: 'Go to show', onPress: () => goTo(imdbId) },
			],
		};
	});
	const watchCards: Card[] = watchlist(trackerLists.flatMap(({ lists }) => lists), (imdbId) => board.byId.has(imdbId)).map((entry) => ({
		key: `watch:${entry.imdbId}`,
		imdbId: entry.imdbId,
		...entryCard(entry, board.byId.has(entry.imdbId)),
		open: () => navigation.navigate('Title', { imdbId: entry.imdbId, kind: entry.kind, title: entry.title, year: entry.year }),
		actions: [],
	}));
	const now = Date.now();
	const upcomingCards: Card[] = episodes
		.filter((ep, n, all) => ep.airsAt >= now && all.findIndex((other) => other.imdbId === ep.imdbId && other.airsAt >= now) === n)
		.slice(0, UPCOMING)
		.map((ep) => {
			const code = episodeCode(ep.season, ep.episode);
			const day = dayStart(ep.airsAt);
			const when = [day <= dayStart(now, 1) ? dayLabel(day, now) : new Date(day).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }), timeLabel(ep)].filter(Boolean).join(' ');
			return {
				key: `upcoming:${ep.imdbId}`,
				imdbId: ep.imdbId,
				title: ep.show,
				detail: `${code} · ${when}`,
				label: `${ep.show} ${code}, ${when}`,
				open: () => navigation.navigate('Title', { imdbId: ep.imdbId, kind: 'tv', title: ep.show }),
				actions: [],
			};
		});
	const recentCards: Card[] = board.recent.map((group) => {
		const state = board.states.get(group.imdbId);
		return {
			key: group.imdbId,
			imdbId: group.imdbId,
			title: group.title,
			detail: group.kind === 'tv' ? [seasonRange(group.seasons) || 'Show', state?.label].filter(Boolean).join(' · ') : String(group.year ?? 'Film'),
			label: `${group.title}, ${group.kind === 'tv' ? 'show' : 'film'}`,
			watched: state?.watched,
			progress: state?.watched ? 0 : state?.progress,
			open: () => goTo(group.imdbId),
			actions: group.kind === 'movie' ? [{ label: state?.watched ? 'Mark unwatched' : 'Mark watched', onPress: () => void watched.set([{ imdbId: group.imdbId }], !state?.watched) }] : [],
		};
	});

	const shelf = (title: string, cards: Card[]) =>
		cards.length === 0 ? null : (
			<View key={title} style={{ marginBottom: 4 }} onLayout={(event) => (shelfTop.current[title] = event.nativeEvent.layout.y)}>
				<Text accessibilityRole="header" style={{ color: theme.text, fontSize: 16, fontWeight: '700', paddingHorizontal: 12, paddingTop: 8, paddingBottom: 8 }}>{title}</Text>
				<FlatList
					horizontal
					data={cards}
					keyExtractor={(card) => card.key}
					extraData={opening}
					showsHorizontalScrollIndicator={false}
					initialNumToRender={8}
					windowSize={5}
					contentContainerStyle={{ paddingHorizontal: 12, gap: GAP }}
					renderItem={({ item: card }) => (
						<PosterCard
							imdbId={card.imdbId}
							title={card.title}
							detail={opening === card.key ? 'Opening…' : card.detail}
							width={cardWidth}
							label={card.label}
							watched={card.watched}
							progress={card.progress}
							dim={card.dim || (Boolean(opening) && opening !== card.key)}
							onPress={card.open}
							onLongPress={card.actions.length ? () => setMenu(card) : undefined}
							onFocus={Platform.isTV ? () => (shelfTop.current[title] ?? 0) < scrolled.current && scroller.current?.scrollTo({ y: shelfTop.current[title] ?? 0 }) : undefined}
						/>
					)}
				/>
			</View>
		);
	const openLibrary = (
		<Pressable accessibilityRole="button" accessibilityLabel="Open Library" onPress={() => navigation.navigate('Main', { screen: 'Library' })} style={[styles.primaryButton, { alignSelf: 'center', backgroundColor: theme.accent }]}>
			<Text style={[styles.primaryButtonText, { color: theme.onAccent }]}>Open Library</Text>
		</Pressable>
	);

	return (
		<Screen>
			{/* A focus guide as wide as the page: Apple TV's remote moves Up only into what lies straight above, and the
			    buttons sit at the right edge, above no poster in a short first row. */}
			<TVFocusGuideView autoFocus style={[styles.row, { paddingHorizontal: 12, paddingTop: 6 }]}>
				<View style={{ flex: 1 }}>
					<Text style={{ color: theme.text, fontSize: 20, fontWeight: '700' }}>Home</Text>
					<Text numberOfLines={2} style={{ color: titles.progress ? theme.accent : theme.muted, fontSize: 12 }}>
						{titles.progress || (continueCards.length || nextCards.length ? 'Press and hold a poster for more' : 'What you play shows up here to continue, and the next episode of each show')}
					</Text>
				</View>
				<IconButton icon="calendar-month" label="Calendar" color={theme.accent} onPress={() => navigation.navigate('Calendar')} />
				{/* Trakt's and Simkl's lists, while either is connected. */}
				{trackerLists.length ? <IconButton icon="format-list-bulleted" label="Lists" color={theme.accent} onPress={() => navigation.navigate('Lists')} /> : null}
			</TVFocusGuideView>
			{startupError ? <ErrorBanner message={`Secure account storage: ${startupError}`} actionLabel="Retry secure account load" onAction={() => void retryStartup()} busy={!ready} /> : null}
			{snapshot.failures.length > 0 ? <ErrorBanner message={snapshot.failures.map((failure) => `${PROVIDER_META[failure.provider].label}: ${failure.message}`).join('\n')} actionLabel="Retry library" onAction={() => void refreshAll()} busy={refreshing} /> : null}
			{!ready ? (
				<EmptyState title="Unlocking secure accounts…" />
			) : snapshot.items.length === 0 ? (
				refreshing ? <EmptyState title="Loading library…" /> : <View><EmptyState title="Nothing in your library yet" detail="Add magnets or .torrent files in Library, or on DMM web. Films and shows show up here as posters, and whatever you start watching waits here to continue." />{openLibrary}</View>
			) : groups.length === 0 ? (
				<View><EmptyState title={titles.progress || refreshing ? 'Naming your library…' : 'No films or shows named yet'} detail={titles.error || 'DMM names each release as a film or show; the rest stay in Library.'} />{openLibrary}</View>
			) : (
				<ScrollView ref={scroller} onScroll={(event) => (scrolled.current = event.nativeEvent.contentOffset.y)} scrollEventThrottle={100} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refreshAll()} tintColor={theme.accent} />} contentContainerStyle={{ paddingBottom: 24 }}>
					{shelf('Continue Watching', continueCards)}
					{shelf('Next Up', nextCards)}
					{shelf('Upcoming', upcomingCards)}
					{shelf('Watchlist', watchCards)}
					{shelf('Recently Added', recentCards)}
				</ScrollView>
			)}
			{menu ? <ActionSheet title={menu.title} detail={menu.detail} actions={menu.actions} onClose={() => setMenu(null)} /> : null}
		</Screen>
	);
}
