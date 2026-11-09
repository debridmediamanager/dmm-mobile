import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Image, Linking, SectionList, Text, View } from 'react-native';
import { useApp } from '../AppContext';
import { dmmPageUrl, imdbIdIn, searchAnime, searchTitles, type SearchRow } from '../search';
import { useAppTheme } from '../theme';
import { EmptyState, ErrorBanner, Pressable, Screen, SearchField, styles } from '../ui';

const ROW = 64;
const DEBOUNCE_MS = 300;

interface Results {
	query: string;
	titles: SearchRow[];
	anime: SearchRow[];
	error?: string;
}

/** DMM's quick search; a row opens its DMM page in the browser, signed in as the app is. */
export function SearchScreen() {
	const theme = useAppTheme();
	const { browserState } = useApp();
	const [query, setQuery] = useState('');
	const [results, setResults] = useState<Results>({ query: '', titles: [], anime: [] });
	const [opening, setOpening] = useState<string | null>(null);
	const typed = query.trim();

	useEffect(() => {
		if (!typed || imdbIdIn(typed)) return;
		let current = true;
		const timer = setTimeout(() => {
			// Anime is extra: its failure (the endpoint's 30 a minute) leaves the titles.
			void Promise.all([searchTitles(typed).catch((error: unknown) => error as Error), searchAnime(typed).catch(() => [])]).then(([titles, anime]) => {
				if (!current) return;
				setResults(titles instanceof Error ? { query: typed, titles: [], anime, error: titles.message } : { query: typed, titles, anime });
			});
		}, DEBOUNCE_MS);
		return () => {
			current = false;
			clearTimeout(timer);
		};
	}, [typed]);

	const open = async (row: SearchRow) => {
		setOpening(row.key);
		try {
			await Linking.openURL(await dmmPageUrl(row.path, await browserState()));
		} catch (error) {
			Alert.alert('Could not open DMM', error instanceof Error ? error.message : String(error));
		} finally {
			setOpening(null);
		}
	};

	const imdb = imdbIdIn(typed);
	const sections = imdb
		? [{ title: '', data: [{ key: imdb, title: `Open ${imdb}`, badge: 'IMDb', anime: false, path: `/x/${imdb}/` }] }]
		: results.query === typed
			? [{ title: '', data: results.titles }, ...(results.anime.length ? [{ title: 'Anime', data: results.anime }] : [])]
			: [];
	const loading = Boolean(typed) && !imdb && results.query !== typed;

	return (
		<Screen>
			<View style={{ paddingHorizontal: 12, paddingTop: 6, paddingBottom: 6, gap: 6 }}>
				<Text style={{ color: theme.text, fontSize: 20, fontWeight: '700' }}>Search</Text>
				<SearchField accessibilityLabel="Search DMM" value={query} onChangeText={setQuery} placeholder="Movie, show, anime or IMDb id" />
			</View>
			{results.error && results.query === typed ? <ErrorBanner message={results.error} /> : null}
			{!typed ? (
				<EmptyState title="Search DMM" detail="Results open on DMM in your browser, signed in as this app is." />
			) : loading ? (
				<ActivityIndicator style={{ marginTop: 24 }} color={theme.accent} />
			) : sections.every((section) => !section.data.length) ? (
				<EmptyState title="Nothing found" />
			) : (
				<SectionList
					sections={sections}
					keyExtractor={(row) => row.key}
					keyboardDismissMode="on-drag"
					keyboardShouldPersistTaps="handled"
					stickySectionHeadersEnabled={false}
					renderSectionHeader={({ section }) =>
						section.title ? <Text style={{ color: '#e879f9', fontSize: 12, fontWeight: '700', letterSpacing: 0.8, paddingHorizontal: 12, paddingVertical: 6 }}>{section.title.toUpperCase()}</Text> : null
					}
					renderItem={({ item: row }) => (
						<Pressable
							accessibilityRole="link"
							accessibilityLabel={`Open ${row.title}${row.year ? ` (${row.year})` : ''} on DMM`}
							onPress={() => void open(row)}
							disabled={opening !== null}
							style={({ pressed, focused }) => [styles.row, { height: ROW, paddingLeft: 12, borderBottomWidth: 1, borderBottomColor: theme.border, backgroundColor: pressed || focused ? theme.surface : 'transparent' }]}
						>
							<Text numberOfLines={1} style={{ flex: 1, color: theme.text, fontSize: 15, fontWeight: '600' }}>
								{row.title}
								{row.year ? <Text style={{ color: theme.muted, fontWeight: '400' }}>{`  (${row.year})`}</Text> : null}
							</Text>
							{opening === row.key ? <ActivityIndicator color={theme.accent} /> : (
								<View style={{ backgroundColor: theme.input, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2 }}>
									<Text style={{ color: row.anime ? '#e879f9' : theme.muted, fontSize: 12 }}>{row.badge}</Text>
								</View>
							)}
							{row.poster ? <Image source={{ uri: row.poster }} style={{ width: ROW * (2 / 3), height: ROW }} resizeMode="cover" accessibilityIgnoresInvertColors /> : <View style={{ width: ROW * (2 / 3) }} />}
						</Pressable>
					)}
				/>
			)}
		</Screen>
	);
}
