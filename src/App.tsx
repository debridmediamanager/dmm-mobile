import { NavigationContainer, DarkTheme as NavigationDarkTheme, DefaultTheme as NavigationDefaultTheme } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppProvider, useApp } from './AppContext';
import type { MainTabParamList, RootStackParamList } from './navigation';
import { AccountsScreen } from './screens/AccountsScreen';
import { DetailScreen } from './screens/DetailScreen';
import { TitleScreen } from './screens/TitleScreen';
import { PlayerScreen } from './screens/PlayerScreen';
import { LibraryScreen } from './screens/LibraryScreen';
import { SearchScreen } from './screens/SearchScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { useAppTheme } from './theme';
import { Platform } from 'react-native';
import { Icon, Pressable, TvScale, useLayout, type IconName } from './ui';
import type { LibrarySession } from './session';
import { PROVIDERS } from './model';

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tabs = createBottomTabNavigator<MainTabParamList>();
const TAB_ICONS: Record<keyof MainTabParamList, [IconName, IconName]> = {
	Library: ['bookshelf', 'bookshelf'],
	Search: ['magnify', 'magnify'],
	Accounts: ['account-key', 'account-key-outline'],
	Settings: ['cog', 'cog-outline'],
};

function MainTabs() {
	const theme = useAppTheme();
	const { wide } = useLayout();
	return (
		<Tabs.Navigator
			screenOptions={({ route }) => ({
				headerShown: false,
				// Tablets and TVs get a rail on the left: a remote reaches it with one press left from anywhere, not past the whole list.
				tabBarPosition: wide ? 'left' : 'bottom',
				tabBarVariant: wide ? 'material' : 'uikit',
				tabBarLabelPosition: wide ? 'below-icon' : undefined,
				// The app's button: an inset focus outline for remotes instead of Android's full-rail ripple.
				tabBarButton: ({ href: _href, android_ripple: _ripple, hoverEffect: _hover, pressOpacity: _opacity, ref: _ref, ...props }) => <Pressable {...(props as React.ComponentProps<typeof Pressable>)} />,
				tabBarIcon: ({ focused, color, size }) => <Icon name={TAB_ICONS[route.name][focused ? 0 : 1]} size={size} color={color} />,
				tabBarActiveTintColor: theme.accent,
				tabBarInactiveTintColor: theme.muted,
				tabBarStyle: { backgroundColor: theme.surface, borderTopColor: theme.border, borderRightColor: theme.border },
				freezeOnBlur: true,
			})}
		>
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
						{/* Its title is the back button's label on iOS pages opened from the library. */}
						<Stack.Screen name="Main" component={MainTabs} options={{ headerShown: false, title: 'Library' }} />
						{/* TVs go back with the remote; the native header would also be drawn twice its size by the Apple TV scale. */}
						<Stack.Screen name="Detail" component={DetailScreen} options={{ title: 'Library item', headerShown: !Platform.isTV }} />
						<Stack.Screen name="Title" component={TitleScreen} options={{ title: '', headerShown: !Platform.isTV }} />
						{/* Full screen, landscape on phones and tablets (TVs are), the remote's Back or Menu leaves. */}
						<Stack.Screen name="Player" component={PlayerScreen} options={{ headerShown: false, orientation: 'landscape', statusBarHidden: true, navigationBarHidden: true, autoHideHomeIndicator: true, contentStyle: { backgroundColor: '#000' } }} />
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
