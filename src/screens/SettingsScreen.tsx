import { useEffect, useState } from 'react';
import { Alert, Platform, ScrollView, Text, View } from 'react-native';
import { useApp } from '../AppContext';
import { PROVIDERS, PROVIDER_META, type ProviderId } from '../model';
import { playersForPlatform } from '../player';
import { loadSettings, onSettingsChange, saveSetting, type AppSettings, type SettingName } from '../settings';
import { useAppTheme } from '../theme';
import { ActionSheet, DropdownChip, Screen, styles, type SheetAction, useLayout } from '../ui';

/** The DMM web Settings that apply to the app, under the same keys so they follow you across devices. */
export function SettingsScreen() {
	const theme = useAppTheme();
	const { wide } = useLayout();
	const { snapshot } = useApp();
	const [settings, setSettings] = useState<AppSettings>({});
	const [picking, setPicking] = useState<SettingName | null>(null);
	useEffect(() => {
		const load = () => void loadSettings().then(setSettings);
		load();
		return onSettingsChange(load);
	}, []);
	const save = (name: SettingName, value: string) => void saveSetting(name, value).catch((caught) => Alert.alert('Could not save the setting', caught instanceof Error ? caught.message : String(caught)));

	const players = playersForPlatform();
	const player = players.find((option) => option.id === settings.player) ?? players[0];
	const connected = PROVIDERS.filter((id) => snapshot.connected[id]);
	// A saved provider that is not connected here (it may be on DMM web) leaves adds on the first connected one.
	const addProvider = settings.addProvider && connected.includes(settings.addProvider as ProviderId) ? (settings.addProvider as ProviderId) : null;

	const options: Record<SettingName, SheetAction[]> = {
		player: players.map((option) => ({ label: option.label, checked: option.id === player.id, onPress: () => save('player', option.id) })),
		addProvider: connected.map((id) => ({ label: PROVIDER_META[id].label, checked: id === addProvider, onPress: () => save('addProvider', id) })),
	};

	const row = (title: string, detail: string, control: React.ReactNode) => (
		<View style={[styles.accountCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
			<View style={styles.rowBetween}>
				<Text style={[styles.accountTitle, { color: theme.text, flex: 1 }]}>{title}</Text>
				{control}
			</View>
			<Text style={[styles.subheading, { color: theme.muted, marginTop: 0 }]}>{detail}</Text>
		</View>
	);

	return (
		<Screen>
			<ScrollView contentContainerStyle={[styles.content, wide && styles.contentWide]}>
				<Text style={[styles.heading, { color: theme.text }]}>Settings</Text>
				{row('Open videos with', Platform.isTV ? 'Used when you open a video file. The same list as DMM web.' : 'Used when you open a video file. Subtitles and other files open in the browser. The same list as DMM web.', <DropdownChip label={player.label} active={player.id !== 'browser'} onPress={() => setPicking('player')} />)}
				{row('Add to', 'The provider the Add screen and magnet links from other apps start on.', <DropdownChip label={addProvider ? PROVIDER_META[addProvider].label : 'First connected'} active={Boolean(addProvider)} onPress={() => setPicking('addProvider')} />)}
				{row('Remembered across devices', 'Always on in the app. Sign in to any one provider here or on DMM web with "Remember my logins and settings across devices", and your other logins and these settings come back. Anyone who can sign in to one of those accounts gets all of them, so do not use a shared debrid account.', <Text style={{ color: theme.accent, fontWeight: '700' }}>On</Text>)}
			</ScrollView>
			{picking ? <ActionSheet title={picking === 'player' ? 'Open videos with' : 'Add to'} actions={options[picking]} onClose={() => setPicking(null)} /> : null}
		</Screen>
	);
}
