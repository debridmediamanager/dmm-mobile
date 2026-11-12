import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Alert, Linking, Modal, Platform, Pressable as RNPressable, RefreshControl, SectionList, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useApp } from '../AppContext';
import { byDay, calendar, dayLabel, dayStart, heldCopies, timeLabel, type CalendarEpisode } from '../calendar';
import type { RootStackParamList } from '../navigation';
import { dmmPageUrl } from '../search';
import { useAppTheme } from '../theme';
import { episodeCode, pickCopy, type EpisodeCopy, type ShowEpisodes } from '../titles';
import { DMM_ORIGIN } from '../tvLink';
import { EmptyState, FilterButton, Icon, Pressable, QrCode, Screen, TvScale, styles, useSheetStyles } from '../ui';
import { watched } from '../watched';
import { useCalendar, useLibraryTitles, useOpenCopy, useWatch } from './hooks';
import { TvHeading } from './ListsScreen';
import { Poster } from './TitlesView';

const PADDING = 12;
const edges: Array<'top' | 'bottom'> = Platform.isTV ? ['top', 'bottom'] : ['bottom'];

/** What an episode row does: play the library's copy, find it on DMM (aired, not held), or wait. */
type RowState = { held: EpisodeCopy } | { aired: true } | { upcoming: true };

/**
 * Your shows' episodes by day: what airs today and in the next 30 days, or what aired in the last 7. An episode the
 * library holds plays; one that aired and is not held opens its season on DMM (a QR code on a TV); one still to come
 * opens the show.
 */
export function CalendarScreen({ navigation }: NativeStackScreenProps<RootStackParamList, 'Calendar'>) {
	const theme = useAppTheme();
	const { titles, browserState } = useApp();
	const library = useLibraryTitles();
	const { episodes, refresh } = useCalendar();
	const { watchVersion } = useWatch();
	const openCopy = useOpenCopy();
	const version = useSyncExternalStore(titles.subscribe, titles.getVersion);
	const [view, setView] = useState<'upcoming' | 'aired'>('upcoming');
	const [refreshing, setRefreshing] = useState(false);
	const [opening, setOpening] = useState('');
	const [qr, setQr] = useState<{ title: string; url: string } | null>(null);
	const now = Date.now();
	const today = dayStart(now);

	// An aired episode is looked for in its show's file lists, which Real-Debrid does not list: read each show's once.
	const reading = useRef(new Set<string>());
	useEffect(() => {
		for (const ep of episodes) {
			const group = library.get(ep.imdbId);
			if (!group || ep.airsAt > Date.now() || reading.current.has(ep.imdbId)) continue;
			reading.current.add(ep.imdbId);
			void titles.loadFiles(group.items).catch(() => undefined);
		}
	}, [episodes, library, titles]);

	// `version`: files read since. `watchVersion`: ticks.
	const shows = useMemo(() => {
		const found = new Map<string, ShowEpisodes>();
		for (const ep of episodes) {
			const group = library.get(ep.imdbId);
			if (group && !found.has(ep.imdbId)) found.set(ep.imdbId, titles.episodesOf(group.items, ep.imdbId));
		}
		return found;
	}, [episodes, library, titles, version]);
	const stateOf = (ep: CalendarEpisode): RowState => {
		const show = shows.get(ep.imdbId);
		const copies = show ? heldCopies(show, ep.season, ep.episode) : [];
		return copies.length ? { held: pickCopy(copies) } : ep.airsAt <= now ? { aired: true } : { upcoming: true };
	};

	const sections = useMemo(() => {
		const days = byDay(episodes.filter((ep) => (view === 'upcoming' ? ep.airsAt >= today : ep.airsAt < today)));
		return (view === 'aired' ? days.reverse() : days).map(({ day, episodes: data }) => ({ title: dayLabel(day, now), data }));
	}, [episodes, view, today]);

	const pull = () => {
		setRefreshing(true);
		void refresh().finally(() => setRefreshing(false));
	};
	const onDmm = async (ep: CalendarEpisode) => {
		const path = `/show/${ep.imdbId}/${ep.season}`;
		// A TV has no browser: the plain page as a QR code, never with a sign-in code a phone would take the TV's logins from.
		if (Platform.isTV) return setQr({ title: `${ep.show} season ${ep.season}`, url: `${DMM_ORIGIN}${path}` });
		await Linking.openURL(await dmmPageUrl(path, await browserState()));
	};
	const press = (ep: CalendarEpisode, state: RowState, key: string) => {
		if ('upcoming' in state) return navigation.navigate('Title', { imdbId: ep.imdbId, kind: 'tv', title: ep.show });
		if (opening) return;
		setOpening(key);
		const action = 'held' in state ? openCopy(state.held.item, (files) => files.find((file) => file.id === state.held.file.id)) : onDmm(ep);
		void action
			.catch((caught) => Alert.alert('Could not open it', caught instanceof Error ? caught.message : String(caught)))
			.finally(() => setOpening(''));
	};

	return (
		<Screen edges={edges}>
			<TvHeading title="Calendar" />
			<View style={[styles.row, { paddingHorizontal: PADDING, paddingTop: 8, paddingBottom: 4, gap: 8 }]}>
				<FilterButton label="Upcoming" active={view === 'upcoming'} onPress={() => setView('upcoming')} />
				<FilterButton label="Last 7 days" active={view === 'aired'} onPress={() => setView('aired')} />
			</View>
			{calendar.progress || calendar.error ? <Text style={{ color: calendar.error ? theme.danger : theme.accent, fontSize: 12.5, paddingHorizontal: PADDING, paddingBottom: 4 }}>{calendar.error || calendar.progress}</Text> : null}
			<SectionList
				sections={sections}
				keyExtractor={(ep) => `${ep.imdbId}:${ep.season}:${ep.episode}`}
				extraData={`${opening}|${watchVersion}|${version}`}
				stickySectionHeadersEnabled={false}
				refreshControl={<RefreshControl refreshing={refreshing} onRefresh={pull} tintColor={theme.accent} />}
				contentContainerStyle={{ paddingBottom: 24, flexGrow: 1 }}
				ListEmptyComponent={
					<EmptyState
						title={view === 'upcoming' ? 'Nothing of your shows in the next 30 days' : 'Nothing of your shows aired in the last 7 days'}
						detail="Your shows are the shows in your library and, with Trakt or Simkl connected, the ones you watch or keep on your watchlist."
					/>
				}
				renderSectionHeader={({ section }) => <Text accessibilityRole="header" style={{ color: theme.text, fontSize: 16, fontWeight: '700', paddingHorizontal: PADDING, paddingTop: 14, paddingBottom: 6 }}>{section.title}</Text>}
				renderItem={({ item: ep }) => {
					const key = `${ep.imdbId}:${ep.season}:${ep.episode}`;
					const state = stateOf(ep);
					const seen = watched.watchedAt({ imdbId: ep.imdbId, season: ep.season, episode: ep.episode }) !== undefined;
					const code = episodeCode(ep.season, ep.episode);
					const time = timeLabel(ep);
					const what = 'held' in state ? (seen ? 'Watched' : 'In your library') : 'aired' in state ? (Platform.isTV ? 'Not in your library · QR code for DMM' : 'Not in your library · Open on DMM') : '';
					const icon = 'held' in state ? 'play-circle' : 'aired' in state ? (Platform.isTV ? 'qrcode' : 'open-in-new') : 'chevron-right';
					return (
						<Pressable
							accessibilityRole="button"
							accessibilityLabel={[ep.show, code, ep.title, time, what].filter(Boolean).join(', ')}
							onPress={() => press(ep, state, key)}
							onLongPress={() => navigation.navigate('Title', { imdbId: ep.imdbId, kind: 'tv', title: ep.show })}
							style={({ pressed, focused }) => [styles.row, { gap: 10, paddingHorizontal: PADDING, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: theme.border, backgroundColor: pressed || focused ? theme.surface : 'transparent', opacity: opening && opening !== key ? 0.6 : 1 }]}
						>
							<Poster imdbId={ep.imdbId} title={ep.show} width={44} watched={seen} />
							<View style={{ flex: 1 }}>
								<Text numberOfLines={1} style={{ color: theme.text, fontSize: 15, fontWeight: '600' }}>{ep.show}</Text>
								<Text numberOfLines={1} style={{ color: theme.muted, fontSize: 13 }}>{[code, ep.title].filter(Boolean).join(' · ')}</Text>
								{what ? <Text numberOfLines={1} style={{ color: 'held' in state ? theme.accent : theme.muted, fontSize: 12.5 }}>{opening === key ? 'Opening…' : what}</Text> : null}
							</View>
							<View style={{ alignItems: 'flex-end', gap: 4 }}>
								{time ? <Text style={{ color: theme.muted, fontSize: 12.5 }}>{time}</Text> : null}
								<Icon name={icon} size={22} color={'held' in state ? theme.accent : theme.muted} />
							</View>
						</Pressable>
					);
				}}
			/>
			{qr ? <QrSheet {...qr} onClose={() => setQr(null)} /> : null}
		</Screen>
	);
}

/** A TV's way to a DMM page: a QR code for a phone to open it. */
function QrSheet({ title, url, onClose }: { title: string; url: string; onClose: () => void }) {
	const theme = useAppTheme();
	const sheet = useSheetStyles();
	return (
		<Modal visible animationType="fade" transparent onRequestClose={onClose}>
			<TvScale>
				<RNPressable focusable={false} style={sheet.backdrop} onPress={onClose}>
					<View style={[sheet.sheet, { backgroundColor: theme.surface, alignItems: 'center', gap: 12 }]}>
						<Text style={[styles.modalTitle, { color: theme.text, textAlign: 'center' }]}>{title}</Text>
						<QrCode value={url} size={220} />
						<Text style={{ color: theme.muted, fontSize: 13.5, textAlign: 'center' }}>Scan to open it on DMM with your phone; what you add there shows up here.</Text>
						<Pressable hasTVPreferredFocus accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} style={[styles.outlineButton, { borderColor: theme.accent, alignSelf: 'stretch', alignItems: 'center' }]}>
							<Text style={[styles.outlineButtonText, { color: theme.accent }]}>Close</Text>
						</Pressable>
					</View>
				</RNPressable>
			</TvScale>
		</Modal>
	);
}
