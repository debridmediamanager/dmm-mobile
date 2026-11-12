import { useEffect, useState } from 'react';
import { FlatList, Platform, RefreshControl, SectionList, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { ListEntry, TrackerList } from '../lists';
import type { RootStackParamList } from '../navigation';
import { useAppTheme } from '../theme';
import type { TrackerSync } from '../trackerSync';
import { EmptyState, Icon, Pressable, Screen, styles } from '../ui';
import { useLibraryTitles, useTrackerLists } from './hooks';
import { PosterCard } from './TitlesView';

const GAP = 10;
const PADDING = 12;
/** As the Titles grid: three cards on a phone, six on a TV, more on a tablet. */
const MIN_CARD = 104;
const edges: Array<'top' | 'bottom'> = Platform.isTV ? ['top', 'bottom'] : ['bottom'];

/** Pull to refresh: every tracker's stamps now, and the lists that changed. */
function useRefresh(trackers: TrackerSync[]): [boolean, () => void] {
	const [refreshing, setRefreshing] = useState(false);
	return [refreshing, () => {
		setRefreshing(true);
		void Promise.all(trackers.map((tracker) => tracker.sync(true))).finally(() => setRefreshing(false));
	}];
}

const count = (n: number) => `${n.toLocaleString()} ${n === 1 ? 'title' : 'titles'}`;
/** A TV has no header: the page names itself. */
const TvHeading = ({ title }: { title: string }) => {
	const theme = useAppTheme();
	return Platform.isTV ? <Text style={{ color: theme.text, fontSize: 20, fontWeight: '700', paddingHorizontal: PADDING, paddingTop: 6, paddingBottom: 6 }}>{title}</Text> : null;
};

/** The connected trackers' lists, each with how much of it the library holds; one opens as posters. */
export function ListsScreen({ navigation }: NativeStackScreenProps<RootStackParamList, 'Lists'>) {
	const theme = useAppTheme();
	const connected = useTrackerLists();
	const library = useLibraryTitles();
	const [refreshing, refresh] = useRefresh(connected.map(({ tracker }) => tracker));
	const sections = connected.map(({ tracker, lists }) => ({ tracker, title: tracker.api.name, data: lists }));
	return (
		<Screen edges={edges}>
			<TvHeading title="Lists" />
			{sections.length === 0 ? (
				<EmptyState title="No lists" detail="Connect Trakt or Simkl in Settings to see your watchlist and lists here." />
			) : (
				<SectionList
					sections={sections}
					keyExtractor={(list) => list.id}
					stickySectionHeadersEnabled={false}
					refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={theme.accent} />}
					contentContainerStyle={{ paddingBottom: 24 }}
					renderSectionHeader={({ section }) => <Text accessibilityRole="header" style={{ color: theme.text, fontSize: 16, fontWeight: '700', paddingHorizontal: PADDING, paddingTop: 14, paddingBottom: 6 }}>{section.title}</Text>}
					renderSectionFooter={({ section }) =>
						section.data.length === 0 || section.tracker.error ? (
							<Text style={{ color: section.tracker.error ? theme.danger : theme.muted, fontSize: 13, paddingHorizontal: PADDING, paddingBottom: 6 }}>{section.tracker.error || `Nothing on your ${section.title} lists yet.`}</Text>
						) : null
					}
					renderItem={({ item: list, section }) => {
						const held = list.items.filter((item) => library.has(item.imdbId)).length;
						const detail = [count(list.items.length), held ? `${held.toLocaleString()} in your library` : '', list.owner ? `by ${list.owner}` : ''].filter(Boolean).join(' · ');
						return (
							<Pressable
								accessibilityRole="button"
								accessibilityLabel={`${list.name}, ${detail}`}
								onPress={() => navigation.navigate('List', { tracker: section.tracker.api.id, id: list.id })}
								style={({ pressed, focused }) => [styles.row, { minHeight: 58, paddingHorizontal: PADDING, borderBottomWidth: 1, borderBottomColor: theme.border, backgroundColor: pressed || focused ? theme.surface : 'transparent' }]}
							>
								<View style={{ flex: 1 }}>
									<Text numberOfLines={1} style={{ color: theme.text, fontSize: 15, fontWeight: '600' }}>{list.name}</Text>
									<Text numberOfLines={1} style={{ color: theme.muted, fontSize: 12.5 }}>{detail}</Text>
								</View>
								<Icon name="chevron-right" size={22} color={theme.muted} />
							</Pressable>
						);
					}}
				/>
			)}
		</Screen>
	);
}

/** A poster card for a list's title: full when the library holds it, dimmed when it does not. */
export function entryCard(entry: ListEntry, held: boolean) {
	const where = held ? 'In library' : 'Not in library';
	return {
		title: entry.title,
		detail: [entry.year, where].filter(Boolean).join(' · '),
		label: `${entry.title}${entry.year ? ` (${entry.year})` : ''}, ${entry.kind === 'tv' ? 'show' : 'film'}, ${held ? 'in your library' : 'not in your library'}`,
		dim: !held,
	};
}

/** One list as posters. A title the library holds opens its page; any other, what it is and where to find it on DMM. */
export function ListScreen({ route, navigation }: NativeStackScreenProps<RootStackParamList, 'List'>) {
	const theme = useAppTheme();
	const connected = useTrackerLists();
	const library = useLibraryTitles();
	const found = connected.find(({ tracker }) => tracker.api.id === route.params.tracker);
	const list: TrackerList | undefined = found?.lists.find((other) => other.id === route.params.id);
	const [refreshing, refresh] = useRefresh(found ? [found.tracker] : []);
	const [width, setWidth] = useState(0);
	useEffect(() => navigation.setOptions({ title: list?.name ?? '' }), [list?.name, navigation]);
	const columns = Math.max(3, Math.floor((width - 2 * PADDING + GAP) / (MIN_CARD + GAP)));
	const cardWidth = width ? Math.floor((width - 2 * PADDING - GAP * (columns - 1)) / columns) : 0;
	const held = list?.items.filter((item) => library.has(item.imdbId)).length ?? 0;
	return (
		<Screen edges={edges}>
			<TvHeading title={list?.name ?? 'List'} />
			{found && list ? (
				<Text style={{ color: theme.muted, fontSize: 12.5, paddingHorizontal: PADDING, paddingTop: 8, paddingBottom: 4 }}>
					{[found.tracker.api.name, count(list.items.length), `${held.toLocaleString()} in your library`].join(' · ')}
				</Text>
			) : null}
			<View style={{ flex: 1 }} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
				{!list ? (
					<EmptyState title="This list is gone" detail="It was removed, or its tracker was disconnected." />
				) : width === 0 ? null : list.items.length === 0 ? (
					<EmptyState title="Nothing on this list" />
				) : (
					<FlatList
						key={columns}
						data={list.items}
						numColumns={columns}
						keyExtractor={(item) => item.imdbId}
						initialNumToRender={12}
						windowSize={7}
						refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={theme.accent} />}
						columnWrapperStyle={{ gap: GAP, paddingHorizontal: PADDING }}
						contentContainerStyle={{ paddingTop: 4, paddingBottom: 24, gap: GAP }}
						renderItem={({ item }) => (
							<PosterCard
								imdbId={item.imdbId}
								width={cardWidth}
								{...entryCard(item, library.has(item.imdbId))}
								onPress={() => navigation.navigate('Title', { imdbId: item.imdbId, kind: item.kind, title: item.title, year: item.year })}
							/>
						)}
					/>
				)}
			</View>
		</Screen>
	);
}
