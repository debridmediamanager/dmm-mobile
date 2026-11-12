export type RootStackParamList = {
	SignIn: undefined;
	Main: undefined;
	Detail: { itemId: string };
	/** A film or show of the library, by IMDb id. */
	Title: { imdbId: string };
};

export type MainTabParamList = {
	Library: undefined;
	Search: undefined;
	Accounts: undefined;
	Settings: undefined;
};
