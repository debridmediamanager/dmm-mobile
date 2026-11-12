import type { NavigatorScreenParams } from '@react-navigation/native';
import type { LibraryItem } from './model';
import type { PickedFile } from './providerApi';

export type RootStackParamList = {
	SignIn: undefined;
	Main: NavigatorScreenParams<MainTabParamList> | undefined;
	Detail: { itemId: string };
	/** A film or show of the library, by IMDb id. */
	Title: { imdbId: string };
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
