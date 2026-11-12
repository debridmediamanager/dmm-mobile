import type { NavigatorScreenParams } from '@react-navigation/native';
import type { LibraryItem } from './model';
import type { PickedFile } from './providerApi';
import type { Tracker } from './watched';

export type RootStackParamList = {
	SignIn: undefined;
	Main: NavigatorScreenParams<MainTabParamList> | undefined;
	Detail: { itemId: string };
	/** A film or show by IMDb id: the library's page of it, or what it is and where to find it on DMM (from a list). */
	Title: { imdbId: string; kind?: 'movie' | 'tv'; title?: string; year?: number };
	/** The connected trackers' lists. */
	Lists: undefined;
	/** One of them as posters. */
	List: { tracker: Tracker; id: string };
	/** Your shows' episodes: the last 7 days and the next 30. */
	Calendar: undefined;
	/** The built-in player: a resolved link to one file of `item`, whose files are listed. */
	Player: { url: string; item: LibraryItem; fileId: string; resume?: boolean };
};

export type MainTabParamList = {
	Home: undefined;
	/** `incoming`: a magnet or .torrent another app opened the app with, for Add. */
	Library: { incoming?: { text: string; file?: PickedFile } } | undefined;
	Search: undefined;
	Accounts: undefined;
	Settings: undefined;
};
