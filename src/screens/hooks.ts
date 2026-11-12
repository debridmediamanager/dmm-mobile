import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useApp } from '../AppContext';
import type { LibraryFile, LibraryItem } from '../model';
import type { RootStackParamList } from '../navigation';
import { playback } from '../playback';
import { openFileLink, playsBuiltIn } from '../player';
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
