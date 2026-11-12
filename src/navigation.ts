import type { LibraryItem } from './model';

export type RootStackParamList = {
	SignIn: undefined;
	Main: undefined;
	Detail: { itemId: string };
	/** A film or show of the library, by IMDb id. */
	Title: { imdbId: string };
	/** The built-in player: a resolved link to one file of `item`, whose files are listed. */
	Player: { url: string; item: LibraryItem; fileId: string };
};

export type MainTabParamList = {
	Library: undefined;
	Search: undefined;
	Accounts: undefined;
	Settings: undefined;
};
