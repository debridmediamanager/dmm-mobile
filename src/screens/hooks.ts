import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useApp } from '../AppContext';
import { calendar, yourShows, type CalendarEpisode } from '../calendar';
import type { TrackerList } from '../lists';
import type { LibraryFile, LibraryItem } from '../model';
import type { RootStackParamList } from '../navigation';
import { playback } from '../playback';
import { openFileLink, playsBuiltIn } from '../player';
import { groupTitles, type TitleGroup } from '../titles';
import type { TrackerSync } from '../trackerSync';
import { isSafeExternalUrl } from '../validation';
import { watched } from '../watched';

/** Re-renders on every change to what was watched or played; the numbers are memo keys. */
export function useWatch(): { watchVersion: number; playVersion: number } {
	useEffect(() => {
		void watched.load();
		void playback.load();
	}, []);
	return { watchVersion: useSyncExternalStore(watched.subscribe, watched.getVersion), playVersion: useSyncExternalStore(playback.watch, playback.getVersion) };
}

/**
 * Opens one video of a copy: in the built-in player (`resume` skips its Resume or Start over
 * question) or the player app chosen in Settings. Throws a readable error.
 */
export function useOpenCopy(): (item: LibraryItem, pick: (files: LibraryFile[]) => LibraryFile | undefined, resume?: boolean) => Promise<void> {
	const { titles, detail, openFile } = useApp();
	const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
	return useCallback(
		async (item, pick, resume = false) => {
			const files = titles.filesOf(item) ?? (await detail(item.provider, item.id)).files;
			const file = pick(files);
			if (!file) throw new Error('This copy has no video to open yet.');
			const url = await openFile(item.provider, { ...item, files }, file.id);
			if (!isSafeExternalUrl(url)) throw new Error('The provider returned an unsafe file URL.');
			if (await playsBuiltIn(file.name)) navigation.navigate('Player', { url, item: { ...item, files }, fileId: file.id, resume });
			else await openFileLink(url, file.name.split('/').pop() ?? file.name);
		},
		[detail, navigation, openFile, titles]
	);
}

const idle = () => () => undefined;
const zero = () => 0;

/** The library's films and shows by IMDb id, regrouped as DMM names releases. */
export function useLibraryTitles(): Map<string, TitleGroup> {
	const { snapshot, titles } = useApp();
	const version = useSyncExternalStore(titles.subscribe, titles.getVersion);
	// `version` is the index's change signal.
	return useMemo(() => new Map(groupTitles(snapshot.items, (item) => titles.identification(item)).titles.map((group) => [group.imdbId, group])), [snapshot.items, titles, version]);
}

/**
 * The lists of each connected tracker (src/lists.ts), none with the demo key alone. Their activity stamps are read
 * whenever the screen using this comes into view, at most as often as each tracker allows (Trakt every minute,
 * Simkl every 15); a list is downloaded only when they moved.
 */
export function useTrackerLists(): { tracker: TrackerSync; lists: TrackerList[] }[] {
	const { trakt, simkl, trackers, trackersAvailable } = useApp();
	useSyncExternalStore(trakt ? trakt.subscribe : idle, trakt ? trakt.getVersion : zero);
	useSyncExternalStore(simkl ? simkl.subscribe : idle, simkl ? simkl.getVersion : zero);
	useSyncExternalStore(trakt ? trakt.account.subscribe : idle, () => trakt?.account.login);
	useSyncExternalStore(simkl ? simkl.account.subscribe : idle, () => simkl?.account.login);
	useFocusEffect(useCallback(() => trackers.forEach((tracker) => void tracker.sync()), [trackers]));
	return trackersAvailable ? trackers.filter((tracker) => tracker.account.login).map((tracker) => ({ tracker, lists: tracker.lists() })) : [];
}

/**
 * Your shows' episodes from 7 days back to 30 ahead (src/calendar.ts). Whatever is due is read again whenever the
 * screen using this comes into view (`refresh` reads now: pull to refresh). Trakt's calendar only with a real
 * provider login, never with the demo key alone.
 */
export function useCalendar(): { episodes: CalendarEpisode[]; refresh(): Promise<void> } {
	const { trakt, trackersAvailable } = useApp();
	const library = useLibraryTitles();
	const trackerLists = useTrackerLists();
	const version = useSyncExternalStore(calendar.subscribe, calendar.getVersion);
	const shows = yourShows(library.values(), trackerLists);
	const latest = useRef(shows);
	latest.current = shows;
	const key = shows.map((show) => show.imdbId).join(',');
	const traktOn = Boolean(trackersAvailable && trakt?.account.login);
	const read = useCallback(
		async (force: boolean) => {
			// Whether Trakt is connected is known once its login is read: until then its shows would look like nobody's.
			await trakt?.account.load();
			await calendar.refresh(latest.current, trackersAvailable && trakt?.account.login ? trakt : null, force);
		},
		[trakt, trackersAvailable]
	);
	useFocusEffect(useCallback(() => void read(false).catch(() => undefined), [read, key, traktOn]));
	// `version` and `key` are the store's and the list's change signals.
	const episodes = useMemo(() => calendar.episodes(latest.current, traktOn), [version, key, traktOn]);
	return { episodes, refresh: useCallback(() => read(true).catch(() => undefined), [read]) };
}
