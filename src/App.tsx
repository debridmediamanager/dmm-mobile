import { NavigationContainer, DarkTheme as NavigationDarkTheme, DefaultTheme as NavigationDefaultTheme } from '@react-navigation/native';
import { BottomTabBar, createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator, type NativeStackScreenProps } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppProvider, useApp } from './AppContext';
import type { MainTabParamList, RootStackParamList } from './navigation';
import { AccountsScreen } from './screens/AccountsScreen';
import { CalendarScreen } from './screens/CalendarScreen';
import { DetailScreen } from './screens/DetailScreen';
import { HomeScreen } from './screens/HomeScreen';
import { TitleScreen } from './screens/TitleScreen';
import { PlayerScreen } from './screens/PlayerScreen';
import { PLAYER_SCREEN } from './player';
import { LibraryScreen } from './screens/LibraryScreen';
import { ListScreen, ListsScreen } from './screens/ListsScreen';
import { SearchScreen } from './screens/SearchScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { useAppTheme } from './theme';
import { useEffect } from 'react';
import { Linking, Platform, Text, TVFocusGuideView, View } from 'react-native';
import { Icon, Pressable, TvScale, useLayout, type IconName } from './ui';
import type { LibrarySession } from './session';
import { PROVIDERS } from './model';
import { parseIncomingLink } from './share';

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tabs = createBottomTabNavigator<MainTabParamList>();
const TAB_ICONS: Record<keyof MainTabParamList, [IconName, IconName]> = {
	Home: ['home', 'home-outline'],
	Library: ['bookshelf', 'bookshelf'],
	Search: ['magnify', 'magnify'],
	Accounts: ['account-key', 'account-key-outline'],
	Settings: ['cog', 'cog-outline'],
};

function MainTabs({ navigation }: NativeStackScreenProps<RootStackParamList, 'Main'>) {
	const theme = useAppTheme();
	const { wide, tv } = useLayout();
	// A magnet or .torrent opened from another app goes to Library's Add, which may not be mounted yet: Home comes first.
	useEffect(() => {
		const open = (url: string | null | undefined) => {
			const link = parseIncomingLink(url);
			if (link) navigation.navigate('Main', { screen: 'Library', params: { incoming: link.kind === 'magnet' ? { text: link.magnet } : { text: '', file: { uri: link.uri, name: link.name } } } });
		};
		void Linking.getInitialURL().then(open);
		const subscription = Linking.addEventListener('url', (event) => open(event.url));
		return () => subscription.remove();
	}, [navigation]);
	return (
		<Tabs.Navigator
			// Apple TV's 80-point side safe area, drawn twice over by TvScale, would make the rail three times its width.
			safeAreaInsets={tv ? { left: 0 } : undefined}
			// The slim rail's buttons end a third of the way down, and Apple TV moves Left only into what lies level with the focus:
			// a guide the rail's full height takes Left from any row to the tab last focused there.
			// It is drawn over the pages for the focused tab's name. A zIndex would also move it after them in Android's view
			// order, and the first key press (nothing focused yet) would then go to the page instead of the rail.
			tabBar={tv ? (props) => <TVFocusGuideView autoFocus style={Platform.OS === 'android' ? { elevation: 1 } : { zIndex: 1 }}><BottomTabBar {...props} /></TVFocusGuideView> : undefined}
			screenOptions={({ route }) => ({
				headerShown: false,
				// Tablets and TVs get a rail on the left: a remote reaches it with one press left from anywhere, not past the whole list.
				tabBarPosition: wide ? 'left' : 'bottom',
				tabBarVariant: wide ? 'material' : 'uikit',
				tabBarLabelPosition: wide ? 'below-icon' : undefined,
				// The app's button: an inset focus outline for remotes instead of Android's full-rail ripple.
				tabBarButton: ({ href: _href, android_ripple: _ripple, hoverEffect: _hover, pressOpacity: _opacity, ref: _ref, children, ...props }) => (
					<Pressable {...(props as React.ComponentProps<typeof Pressable>)}>
						{({ focused }) => (
							<>
								{children}
								{tv && focused ? (
									// Past the 40-dp button (20-dp icon in react-navigation's 10-dp padding) and the rail's edge; a percentage would be
									// taken of the button's inner width.
									<View style={{ position: 'absolute', left: 48, top: 0, bottom: 0, width: 160, justifyContent: 'center', alignItems: 'flex-start' }}>
										<View style={{ borderRadius: 16, paddingHorizontal: 12, paddingVertical: 5, backgroundColor: theme.focus }}>
											<Text style={{ color: theme.background, fontSize: 15, fontWeight: '600' }}>{route.name}</Text>
										</View>
									</View>
								) : null}
							</>
						)}
					</Pressable>
				),
				tabBarIcon: ({ focused, color, size }) => <Icon name={TAB_ICONS[route.name][focused ? 0 : 1]} size={size} color={color} />,
				tabBarActiveTintColor: theme.accent,
				tabBarInactiveTintColor: theme.muted,
				tabBarStyle: [{ backgroundColor: theme.surface, borderTopColor: theme.border, borderRightColor: theme.border }, tv && { flex: 1, paddingStart: 2, paddingEnd: 2 }],
				// TVs get a slim icon rail; the focused tab's name shows beside it, over the page, so the page never shifts.
				...(tv && {
					tabBarShowLabel: false,
					tabBarIconSize: 20,
					tabBarItemStyle: { overflow: 'visible' },
					// Without a label Android has no name to read; iOS already says "Home, tab, 1 of 4".
					tabBarAccessibilityLabel: Platform.OS === 'android' ? route.name : undefined,
				}),
				freezeOnBlur: true,
			})}
		>
			<Tabs.Screen name="Home" component={HomeScreen} options={{ tabBarLabel: 'Home' }} />
			<Tabs.Screen name="Library" component={LibraryScreen} options={{ tabBarLabel: 'Library' }} />
			{/* Its results open in the browser, and a TV has none. */}
			{Platform.isTV ? null : <Tabs.Screen name="Search" component={SearchScreen} options={{ tabBarLabel: 'Search' }} />}
			<Tabs.Screen name="Accounts" component={AccountsScreen} options={{ tabBarLabel: 'Accounts' }} />
			<Tabs.Screen name="Settings" component={SettingsScreen} options={{ tabBarLabel: 'Settings' }} />
		</Tabs.Navigator>
	);
}

export function AppNavigation() {
	const theme = useAppTheme();
	const { ready, startupError, snapshot } = useApp();
	// Sign-in comes first; a storage error stays on the tabs so its Retry banner is reachable.
	const needsSignIn = ready && !startupError && !PROVIDERS.some((provider) => snapshot.connected[provider]);
	const navigationTheme = theme.dark ? NavigationDarkTheme : NavigationDefaultTheme;
	return (
		<TvScale>
		<NavigationContainer
			theme={{
				...navigationTheme,
				colors: { ...navigationTheme.colors, background: theme.background, card: theme.surface, text: theme.text, border: theme.border, primary: theme.accent },
			}}
		>
			<Stack.Navigator screenOptions={{ contentStyle: { backgroundColor: theme.background }, headerStyle: { backgroundColor: theme.surface }, headerTintColor: theme.text, headerShadowVisible: false }}>
				{needsSignIn ? (
					<Stack.Screen name="SignIn" component={AccountsScreen} options={{ headerShown: false }} />
				) : (
					<>
						{/* Its title is the back button's label on iOS pages opened from Home or the library. */}
						<Stack.Screen name="Main" component={MainTabs} options={{ headerShown: false, title: 'Back' }} />
						{/* TVs go back with the remote; the native header would also be drawn twice its size by the Apple TV scale. */}
						<Stack.Screen name="Detail" component={DetailScreen} options={{ title: 'Library item', headerShown: !Platform.isTV }} />
						<Stack.Screen name="Title" component={TitleScreen} options={{ title: '', headerShown: !Platform.isTV }} />
						<Stack.Screen name="Lists" component={ListsScreen} options={{ title: 'Lists', headerShown: !Platform.isTV }} />
						<Stack.Screen name="List" component={ListScreen} options={{ title: '', headerShown: !Platform.isTV }} />
						<Stack.Screen name="Calendar" component={CalendarScreen} options={{ title: 'Calendar', headerShown: !Platform.isTV }} />
						<Stack.Screen name="Player" component={PlayerScreen} options={PLAYER_SCREEN} />
					</>
				)}
			</Stack.Navigator>
			<StatusBar style={theme.dark ? 'light' : 'dark'} />
		</NavigationContainer>
		</TvScale>
	);
}

export default function App(props: { session?: LibrarySession; [key: string]: unknown } = {}) {
	return <SafeAreaProvider><AppProvider session={props.session}><AppNavigation /></AppProvider></SafeAreaProvider>;
}
