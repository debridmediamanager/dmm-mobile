import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Alert, Linking, Platform, ScrollView, Text, View } from 'react-native';
import * as Updates from 'expo-updates';
import { useApp } from '../AppContext';
import { PROVIDERS, PROVIDER_META, type ProviderId } from '../model';
import { playersForPlatform } from '../player';
import { loadSettings, onSettingsChange, saveSetting, type AppSettings, type SettingName } from '../settings';
import { useAppTheme } from '../theme';
import { ActionSheet, DropdownChip, FilterButton, Pressable, QrCode, Screen, styles, type SheetAction, useLayout } from '../ui';
import { DMM_ORIGIN } from '../tvLink';
import { pollTraktLink, startTraktLink, type TraktLink } from '../trakt';
import type { TraktSync } from '../traktSync';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Trakt: who is signed in, or a device code to link one (a QR on a TV, the approve page opened on a phone).
 * DMM web's Trakt login is picked up by itself, so most people never press Connect.
 */
function TraktRow({ trakt }: { trakt: TraktSync }) {
	const theme = useAppTheme();
	const { account } = trakt;
	useSyncExternalStore(account.subscribe, account.getVersion);
	useSyncExternalStore(trakt.subscribe, trakt.getVersion);
	const [link, setLink] = useState<TraktLink | null>(null);
	const [error, setError] = useState('');
	const waiting = useRef<{ cancelled: boolean } | null>(null);
	useEffect(() => () => void (waiting.current && (waiting.current.cancelled = true)), []);
	const cancel = () => {
		if (waiting.current) waiting.current.cancelled = true;
		waiting.current = null;
		setLink(null);
	};
	const connect = async () => {
		cancel();
		const attempt = { cancelled: false };
		waiting.current = attempt;
		setError('');
		try {
			const started = await startTraktLink();
			if (attempt.cancelled) return;
			setLink(started);
			if (!Platform.isTV) void Linking.openURL(started.verifyUrl).catch(() => undefined);
			for (const deadline = Date.now() + started.expiresIn * 1000; Date.now() < deadline; ) {
				await wait(started.interval * 1000);
				if (attempt.cancelled) return;
				// A dropped poll is tried again on the next tick.
				const result = await pollTraktLink(started.deviceCode).catch(() => 'pending' as const);
				if (attempt.cancelled) return;
				if (result === 'expired') throw new Error('That code expired or was declined. Try again.');
				if (result !== 'pending') return void (await account.connect(result));
			}
			throw new Error('That code expired before it was approved. Try again.');
		} catch (caught) {
			if (!attempt.cancelled) setError(caught instanceof Error ? caught.message : 'Could not connect Trakt.');
		} finally {
			if (waiting.current === attempt) cancel();
		}
	};

	const login = account.login;
	const shown = error || (login && trakt.error) || '';
	const page = link?.verifyUrl.replace(/^https?:\/\//, '').replace(/\/[^/]*$/, '');
	const button = (label: string, color: string, onPress: () => void) => (
		<Pressable accessibilityRole="button" accessibilityLabel={`${label} Trakt`} onPress={onPress} style={[styles.outlineButton, { borderColor: color }]}>
			<Text style={[styles.outlineButtonText, { color }]}>{label}</Text>
		</Pressable>
	);
	return (
		<View style={[styles.accountCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
			<View style={styles.rowBetween}>
				<Text style={[styles.accountTitle, { color: theme.text, flex: 1 }]}>Trakt</Text>
				{link ? null : login && !account.refused ? button('Disconnect', theme.danger, () => void account.disconnect()) : button('Connect', theme.accent, () => void connect())}
			</View>
			<Text style={[styles.subheading, { color: theme.muted, marginTop: 0 }]}>
				{login && !account.refused
					? `Signed in${login.slug ? ` as ${login.slug}` : ''}. What you play is scrobbled to Trakt, and watched marks and resume points follow you to your other devices.`
					: login
						? 'Trakt no longer accepts this sign-in. Connect again.'
						: 'Scrobble what you play and keep watched marks and resume points in step with Trakt and your other devices. A Trakt login made on DMM web is used by itself.'}
			</Text>
			{link ? (
				<View style={{ flexDirection: Platform.isTV ? 'row' : 'column', alignItems: 'center', gap: 16 }}>
					{Platform.isTV ? <QrCode value={link.verifyUrl} size={180} /> : null}
					<View style={{ gap: 8, alignItems: Platform.isTV ? 'flex-start' : 'center', flexShrink: 1 }}>
						<Text style={[styles.subheading, { color: theme.muted, marginTop: 0 }]}>{Platform.isTV ? `Scan the code with your phone, or open ${page} and enter:` : `Approve this code on ${page}:`}</Text>
						<Text selectable accessibilityLabel={`Trakt code ${link.userCode}`} style={[styles.deviceCode, { color: theme.text }]}>{link.userCode}</Text>
						{Platform.isTV ? null : (
							<Pressable accessibilityRole="link" accessibilityLabel={`Open ${page}`} onPress={() => void Linking.openURL(link.verifyUrl)} style={[styles.primaryButton, { backgroundColor: theme.accent, alignSelf: 'stretch' }]}>
								<Text style={[styles.primaryButtonText, { color: theme.onAccent }]}>Open {page}</Text>
							</Pressable>
						)}
						<View style={styles.row}>
							<ActivityIndicator color={theme.muted} />
							<Text style={[styles.detailMeta, { color: theme.muted, marginTop: 0 }]}>Waiting for approval…</Text>
						</View>
						{button('Cancel', theme.accent, cancel)}
					</View>
				</View>
			) : null}
			{shown ? <Text style={[styles.inlineError, { color: theme.danger }]}>{shown}</Text> : null}
			<Text style={[styles.detailMeta, { color: theme.muted, marginTop: 0 }]}>DMM Mobile uses Trakt but is not endorsed or certified by Trakt.</Text>
		</View>
	);
}

/** The DMM web Settings that apply to the app, under the same keys so they follow you across devices. */
export function SettingsScreen() {
	const theme = useAppTheme();
	const { wide } = useLayout();
	const { snapshot, trakt, traktAvailable } = useApp();
	const [settings, setSettings] = useState<AppSettings>({});
	const [picking, setPicking] = useState<SettingName | null>(null);
	useEffect(() => {
		const load = () => void loadSettings().then(setSettings);
		load();
		return onSettingsChange(load);
	}, []);
	const updates = Updates.useUpdates();
	const [checking, setChecking] = useState(false);
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

	// The app also checks on every start and applies a downloaded update on the next one; this is for a TV left running.
	const updateApp = async () => {
		if (updates.isUpdatePending) return void Updates.reloadAsync();
		setChecking(true);
		try {
			if ((await Updates.checkForUpdateAsync()).isAvailable) await Updates.fetchUpdateAsync();
			else Alert.alert('DMM Mobile is up to date');
		} catch (caught) {
			Alert.alert('Could not check for updates', caught instanceof Error ? caught.message : String(caught));
		} finally {
			setChecking(false);
		}
	};
	const running = updates.currentlyRunning;
	const versionDetail = !Updates.isEnabled ? 'Updates are off in this build.' : running.isEmbeddedLaunch || !running.createdAt ? 'As installed.' : `Updated ${running.createdAt.toLocaleString()}.`;

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
				{row('Open videos with', `Built-in plays videos in the app. A player app chosen here is used on DMM web too.${Platform.isTV ? '' : ' Subtitle and other files open in the browser.'}`, <DropdownChip label={player.label} active={player.id !== players[0].id} onPress={() => setPicking('player')} />)}
				{row('Add to', 'The provider the Add screen and magnet links from other apps start on.', <DropdownChip label={addProvider ? PROVIDER_META[addProvider].label : 'First connected'} active={Boolean(addProvider)} onPress={() => setPicking('addProvider')} />)}
				{/* The demo key alone never reaches Trakt. */}
				{trakt && traktAvailable ? <TraktRow trakt={trakt} /> : null}
				{row('Remembered across devices', 'Always on in the app. Sign in to any one provider here or on DMM web with "Remember my logins and settings across devices", and your other logins and these settings come back. Anyone who can sign in to one of those accounts gets all of them, so do not use a shared debrid account.', <Text style={{ color: theme.accent, fontWeight: '700' }}>On</Text>)}
				{row(`Version ${Updates.runtimeVersion ?? ''}`.trim(), updates.isUpdatePending ? `${versionDetail} An update is ready.` : versionDetail, Updates.isEnabled ? <FilterButton label={updates.isUpdatePending ? 'Restart' : checking ? 'Checking…' : 'Check'} active={updates.isUpdatePending} onPress={() => void (checking ? undefined : updateApp())} /> : null)}
				{/* A TV has no browser, so it shows where the pages are. */}
				{[['Privacy policy', '/privacy'], ['Help and support', '/support']].map(([title, path]) => <Fragment key={path}>{row(title, Platform.isTV ? `${DMM_ORIGIN.replace('https://', '')}${path}` : 'Opens on debridmediamanager.com.', Platform.isTV ? null : (
					<Pressable accessibilityRole="link" accessibilityLabel={title} onPress={() => void Linking.openURL(`${DMM_ORIGIN}${path}`)} style={[styles.outlineButton, { borderColor: theme.accent }]}>
						<Text style={[styles.outlineButtonText, { color: theme.accent }]}>Open</Text>
					</Pressable>
				))}</Fragment>)}
			</ScrollView>
			{picking ? <ActionSheet title={picking === 'player' ? 'Open videos with' : 'Add to'} actions={options[picking]} onClose={() => setPicking(null)} /> : null}
		</Screen>
	);
}
