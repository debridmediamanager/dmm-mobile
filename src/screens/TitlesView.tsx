import { memo, useMemo, useState, useSyncExternalStore } from 'react';
import { FlatList, Image, RefreshControl, Text, View } from 'react-native';
import { useApp } from '../AppContext';
import { hashKeyOf, mediaTypeOf, normalizeTitle, searchMatcher, titleKeyOf, type LibraryGrouping } from '../core';
import type { LibraryItem, MediaType } from '../model';
import { useAppTheme } from '../theme';
import { groupTitles, posterUrls, seasonRange, type TitleGroup } from '../titles';
import { EmptyState, Icon, LibraryRow, Pressable } from '../ui';
import { playback } from '../playback';
import { resumable, titleStates, watched, type TitleState } from '../watched';
import { useWatch } from './hooks';

const GAP = 10;
const PADDING = 12;
/** A card is at least this wide: three on a phone, six on a TV, more on a tablet. */
const MIN_CARD = 104;
const TEXT_HEIGHT = 38;

type Row = { key: string; cards: TitleGroup[] } | { key: string; header: string } | { key: string; item: LibraryItem };

/** A poster from DMM's CDN, then metahub, then the title in words; a check once watched, a bar while part watched. */
const Poster = memo(function Poster({ imdbId, title, width, focused, watched, progress }: { imdbId?: string; title: string; width: number; focused?: boolean; watched?: boolean; progress?: number }) {
	const theme = useAppTheme();
	const [source, setSource] = useState(0);
	const urls = imdbId ? posterUrls(imdbId) : [];
	return (
		<View style={{ width, height: width * 1.5, borderRadius: 6, overflow: 'hidden', backgroundColor: theme.surface, alignItems: 'center', justifyContent: 'center', borderWidth: focused ? 3 : 1, borderColor: focused ? theme.focus : theme.border }}>
			{source < urls.length ? <Image source={{ uri: urls[source] }} resizeMode="cover" style={{ width: '100%', height: '100%' }} onError={() => setSource((current) => current + 1)} accessibilityIgnoresInvertColors /> : <Text numberOfLines={5} style={{ color: theme.muted, textAlign: 'center', padding: 6, fontSize: 13, fontWeight: '600' }}>{title}</Text>}
			{watched ? <View style={{ position: 'absolute', top: 5, right: 5, borderRadius: 12, backgroundColor: theme.accent, padding: 2 }}><Icon name="check" size={16} color={theme.onAccent} /></View> : null}
			{progress ? <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 5, backgroundColor: 'rgba(0,0,0,0.6)' }}><View style={{ height: 5, width: `${Math.round(progress * 100)}%`, backgroundColor: theme.accent }} /></View> : null}
		</View>
	);
});

/** A poster with its title and one line under it: the Titles grid and Home's rows. */
export const PosterCard = memo(function PosterCard({
	imdbId,
	title,
	detail,
	width,
	label,
	watched,
	progress,
	dim,
	onPress,
	onLongPress,
	onFocus,
}: {
	imdbId?: string;
	title: string;
	detail: string;
	width: number;
	/** Read out by screen readers. */
	label: string;
	watched?: boolean;
	progress?: number;
	dim?: boolean;
	onPress: () => void;
	onLongPress?: () => void;
	onFocus?: () => void;
}) {
	const theme = useAppTheme();
	return (
		<Pressable accessibilityRole="button" accessibilityLabel={`${label}${watched ? ', watched' : ''}`} accessibilityHint={onLongPress ? 'Long press for more' : undefined} onPress={onPress} onLongPress={onLongPress} onFocus={onFocus} style={({ pressed }) => ({ width, opacity: pressed || dim ? 0.6 : 1, borderRadius: 8 })}>
			{/* The poster itself is outlined on a TV: it covers the card's own focus outline. */}
			{({ focused }) => (
				<>
					<Poster imdbId={imdbId} title={title} width={width} focused={focused} watched={watched} progress={progress} />
					<View style={{ height: TEXT_HEIGHT, paddingTop: 4 }}>
						<Text numberOfLines={1} style={{ color: theme.text, fontSize: 12.5, fontWeight: '600' }}>{title}</Text>
						<Text numberOfLines={1} style={{ color: theme.muted, fontSize: 11.5 }}>{detail}</Text>
					</View>
				</>
			)}
		</Pressable>
	);
});

const TitleCard = memo(function TitleCard({ title, width, state, onPress }: { title: TitleGroup; width: number; state?: TitleState; onPress: (title: TitleGroup) => void }) {
	const copies = title.items.length;
	const meta = title.kind === 'tv' ? [seasonRange(title.seasons) || 'Show'] : [title.year ?? 'Film'];
	if (state?.label) meta.push(state.label);
	if (copies > 1) meta.push(`${copies} copies`);
	return (
		<PosterCard
			imdbId={title.imdbId}
			title={title.title}
			detail={meta.join(' · ')}
			width={width}
			label={`${title.title}${title.year ? ` (${title.year})` : ''}, ${title.kind === 'tv' ? 'show' : 'film'}${state?.label ? `, ${state.label} watched` : ''}`}
			watched={state?.watched}
			progress={state?.watched ? 0 : state?.progress}
			onPress={() => onPress(title)}
		/>
	);
});

/**
 * The library as films and shows, each once however many releases and providers hold it, as
 * poster cards; releases DMM could not name stay below as the usual rows.
 */
export function TitlesView({
	items,
	search,
	media,
	grouping,
	selected,
	refreshing,
	onRefresh,
	onOpenTitle,
	onOpenItem,
	onLongPressItem,
	onMoreItem,
}: {
	items: readonly LibraryItem[];
	search: string;
	media: MediaType | 'all';
	grouping: LibraryGrouping;
	selected: ReadonlySet<string>;
	refreshing: boolean;
	onRefresh: () => void;
	onOpenTitle: (title: TitleGroup) => void;
	onOpenItem: (item: LibraryItem) => void;
	onLongPressItem: (item: LibraryItem) => void;
	onMoreItem: (item: LibraryItem) => void;
}) {
	const theme = useAppTheme();
	const { titles } = useApp();
	const version = useSyncExternalStore(titles.subscribe, titles.getVersion);
	const [width, setWidth] = useState(0);
	// `version` is the index's change signal: a new answer regroups.
	const grouped = useMemo(() => groupTitles(items, (item) => titles.identification(item)), [items, titles, version]);
	const { watchVersion, playVersion } = useWatch();
	const states = useMemo(
		() => titleStates(grouped.titles, (group) => titles.episodesOf(group.items, group.imdbId), watched.list(), resumable(playback.list())),
		// the versions are the stores' change signals
		[grouped, titles, version, watchVersion, playVersion]
	);
	const shown = useMemo(() => {
		const words = search.trim().split(/\s+/).filter(Boolean).map(normalizeTitle);
		const matches = search.trim() ? searchMatcher(search.trim()) : null;
		return {
			titles: grouped.titles.filter((title) => (media === 'all' || media === title.kind) && words.every((word) => normalizeTitle(`${title.title} ${title.year ?? ''}`).includes(word))),
			other: grouped.other.filter((item) => (media === 'all' || media === 'other' || media === mediaTypeOf(item)) && (!matches || matches(item))),
		};
	}, [grouped, media, search]);
	const columns = Math.max(3, Math.floor((width - 2 * PADDING + GAP) / (MIN_CARD + GAP)));
	const cardWidth = width ? Math.floor((width - 2 * PADDING - GAP * (columns - 1)) / columns) : 0;
	const rows = useMemo<Row[]>(() => {
		const out: Row[] = [];
		for (let at = 0; at < shown.titles.length; at += columns) out.push({ key: `t${at}`, cards: shown.titles.slice(at, at + columns) });
		if (shown.other.length) {
			out.push({ key: 'other', header: `Other · ${shown.other.length.toLocaleString()}${titles.progress ? ' · naming…' : ''}` });
			for (const item of shown.other) out.push({ key: item.id, item });
		}
		return out;
	}, [columns, shown, titles.progress]);
	const selecting = selected.size > 0;
	const extraData = useMemo(() => [selected, states], [selected, states]);

	return (
		<View style={{ flex: 1 }} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
			{width === 0 ? null : rows.length === 0 ? (
				<EmptyState title={refreshing ? 'Loading library…' : 'No matching titles'} />
			) : (
				<FlatList
					data={rows}
					keyExtractor={(row) => row.key}
					extraData={extraData}
					initialNumToRender={8}
					maxToRenderPerBatch={8}
					windowSize={7}
					removeClippedSubviews
					keyboardDismissMode="on-drag"
					keyboardShouldPersistTaps="handled"
					refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.accent} />}
					contentContainerStyle={{ paddingTop: 4, paddingBottom: 24 }}
					renderItem={({ item: row }) => {
						if ('cards' in row) {
							return (
								<View style={{ flexDirection: 'row', gap: GAP, paddingHorizontal: PADDING, marginBottom: GAP }}>
									{row.cards.map((title) => <TitleCard key={title.imdbId} title={title} width={cardWidth} state={states.get(title.imdbId)} onPress={onOpenTitle} />)}
								</View>
							);
						}
						if ('header' in row) return <Text style={{ color: theme.muted, fontSize: 13, fontWeight: '700', paddingHorizontal: PADDING, paddingTop: 10, paddingBottom: 6 }}>{row.header}</Text>;
						return (
							<LibraryRow
								item={row.item}
								mediaType={mediaTypeOf(row.item)}
								selected={selected.has(row.item.id)}
								selecting={selecting}
								hashCount={row.item.hash ? grouping.hashCounts.get(hashKeyOf(row.item)) ?? 0 : 0}
								titleCount={grouping.titleCounts.get(titleKeyOf(row.item)) ?? 0}
								onPress={onOpenItem}
								onLongPress={onLongPressItem}
								onMore={onMoreItem}
							/>
						);
					}}
				/>
			)}
		</View>
	);
}
