import { NavigationContainer, DarkTheme as NavigationDarkTheme, DefaultTheme as NavigationDefaultTheme } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppProvider, useApp } from './AppContext';
import type { MainTabParamList, RootStackParamList } from './navigation';
import { AccountsScreen } from './screens/AccountsScreen';
import { DetailScreen } from './screens/DetailScreen';
import { LibraryScreen } from './screens/LibraryScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { useAppTheme } from './theme';
import type { LibrarySession } from './session';
import { PROVIDERS } from './model';

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tabs = createBottomTabNavigator<MainTabParamList>();

function MainTabs() {
	const theme = useAppTheme();
	return (
		<Tabs.Navigator
			screenOptions={{
				headerShown: false,
				tabBarIcon: () => null,
				tabBarActiveTintColor: theme.accent,
				tabBarInactiveTintColor: theme.muted,
				tabBarStyle: { backgroundColor: theme.surface, borderTopColor: theme.border },
				freezeOnBlur: true,
			}}
		>
			<Tabs.Screen name="Library" component={LibraryScreen} options={{ tabBarLabel: 'Library' }} />
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
						<Stack.Screen name="Main" component={MainTabs} options={{ headerShown: false }} />
						<Stack.Screen name="Detail" component={DetailScreen} options={{ title: 'Library item' }} />
					</>
				)}
			</Stack.Navigator>
			<StatusBar style={theme.dark ? 'light' : 'dark'} />
		</NavigationContainer>
	);
}

export default function App(props: { session?: LibrarySession; [key: string]: unknown } = {}) {
	return <SafeAreaProvider><AppProvider session={props.session}><AppNavigation /></AppProvider></SafeAreaProvider>;
}
