import { Fragment, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Alert, AppState, Linking, Platform, ScrollView, Switch, Text, View, type ScrollViewInstance } from 'react-native';
import * as Updates from 'expo-updates';
import { useApp } from '../AppContext';
import { alertsAllowed, alertsOn, alertsSupported, setAlerts } from '../alerts';
import { PROVIDERS, PROVIDER_META, type ProviderId } from '../model';
import { playersForPlatform } from '../player';
import { loadSettings, onSettingsChange, saveSetting, type AppSettings, type SettingName } from '../settings';
import { useAppTheme } from '../theme';
import { autoFixesOn, setAutoFixes } from '../updates';
import { ActionSheet, DropdownChip, FilterButton, Pressable, QrCode, Screen, styles, type SheetAction, useLayout } from '../ui';
import { OFFICIAL_DMM_ORIGIN } from '../tvLink';
import { pollSimklLink, startSimklLink, type TrackerLink } from '../simkl';
import { pollTraktLink, startTraktLink } from '../trakt';
import type { TrackerSync } from '../trackerSync';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** What the row needs of Trakt's and Simkl's logins. */
interface RowAccount<Login> {
	readonly login: (Login & { slug?: string; name?: string }) | null;
	readonly refused: boolean;
	readonly readOnly?: boolean;
	connect(login: Login): Promise<void>;
	disconnect(): Promise<void>;
	subscribe(listener: () => void): () => void;
	getVersion(): number;
}

/**
 * A tracker: who is signed in, or a device code to link one (a QR on a TV, the approve page opened on a phone).
 * DMM web's Trakt login is picked up by itself, so most people never press Connect there.
 */
function TrackerRow<Login>({ tracker, account, start, poll, signedOut, footer, reveal }: {
	tracker: TrackerSync<any>;
	account: RowAccount<Login>;
	start(): Promise<TrackerLink>;
	poll(deviceCode: string): Promise<'pending' | 'slow_down' | 'expired' | Login>;
	signedOut: string;
	footer: React.ReactNode;
	/** Scrolls the page to this card's top (y in the page). */
	reveal(y: number): void;
}) {
	const theme = useAppTheme();
	const { name } = tracker.api;
	useSyncExternalStore(account.subscribe, account.getVersion);
	useSyncExternalStore(tracker.subscribe, tracker.getVersion);
	const [link, setLink] = useState<TrackerLink | null>(null);
	const [error, setError] = useState('');
	const waiting = useRef<{ cancelled: boolean } | null>(null);
	useEffect(() => () => void (waiting.current && (waiting.current.cancelled = true)), []);
	// A TV's QR sits under the focused Cancel, below the screen's edge for both cards; nothing there can take focus to scroll to it.
	const top = useRef(0);
	useEffect(() => void (Platform.isTV && link && reveal(top.current)), [link, reveal]);
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
			const started = await start();
			if (attempt.cancelled) return;
			setLink(started);
			if (!Platform.isTV) void Linking.openURL(started.verifyUrl).catch(() => undefined);
			let interval = started.interval;
			for (const deadline = Date.now() + started.expiresIn * 1000; Date.now() < deadline; ) {
				await wait(interval * 1000);
				if (attempt.cancelled) return;
				// A dropped poll is tried again on the next tick.
				const result = await poll(started.deviceCode).catch(() => 'pending' as const);
				if (attempt.cancelled) return;
				if (result === 'expired') throw new Error('That code expired or was declined. Try again.');
				// Simkl: polling too fast keeps it refusing; wait 5 seconds more from now on.
				if (result === 'slow_down') interval += 5;
				else if (result !== 'pending') return void (await account.connect(result));
			}
			throw new Error('That code expired before it was approved. Try again.');
		} catch (caught) {
			if (!attempt.cancelled) setError(caught instanceof Error ? caught.message : `Could not connect ${name}.`);
		} finally {
			if (waiting.current === attempt) cancel();
		}
	};

	const login = account.login;
	const who = login?.slug ?? login?.name;
	const shown = error || (login && tracker.error) || '';
	const page = link?.page;
	const button = (label: string, color: string, onPress: () => void) => (
		<Pressable accessibilityRole="button" accessibilityLabel={`${label} ${name}`} onPress={onPress} style={[styles.outlineButton, { borderColor: color }]}>
			<Text style={[styles.outlineButtonText, { color }]}>{label}</Text>
		</Pressable>
	);
	return (
		<View onLayout={(event) => (top.current = event.nativeEvent.layout.y)} style={[styles.accountCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
			<View style={styles.rowBetween}>
				<Text style={[styles.accountTitle, { color: theme.text, flex: 1 }]}>{name}</Text>
				{/* One button that changes in place (Connect, Cancel, Disconnect): the TV remote's focus stays on it. A button
				    that unmounted dropped the focus to the tab rail or the page, which scrolled the code out of sight. */}
				{link ? button('Cancel', theme.accent, cancel) : login && !account.refused ? button('Disconnect', theme.danger, () => void account.disconnect()) : button('Connect', theme.accent, () => void connect())}
			</View>
			<Text style={[styles.subheading, { color: theme.muted, marginTop: 0 }]}>
				{login && account.refused
					? `${name} no longer accepts this sign-in. Connect again.`
					: login && account.readOnly
						? `Signed in${who ? ` as ${who}` : ''}, but ${name} lets DMM Mobile only read your library: watched marks come from ${name}, nothing goes to it. Disconnect and connect again to allow updates.`
						: login
							? `Signed in${who ? ` as ${who}` : ''}. What you play is scrobbled to ${name}, and watched marks and resume points follow you to your other devices.`
							: signedOut}
			</Text>
			{link ? (
				<View style={{ flexDirection: Platform.isTV ? 'row' : 'column', alignItems: 'center', gap: 16 }}>
					{Platform.isTV ? <QrCode value={link.verifyUrl} size={180} /> : null}
					<View style={{ gap: 8, alignItems: Platform.isTV ? 'flex-start' : 'center', flexShrink: 1 }}>
						<Text style={[styles.subheading, { color: theme.muted, marginTop: 0 }]}>{Platform.isTV ? `Scan the code with your phone, or open ${page} and enter:` : `Approve this code on ${page}:`}</Text>
						<Text selectable accessibilityLabel={`${name} code ${link.userCode}`} style={[styles.deviceCode, { color: theme.text }]}>{link.userCode}</Text>
						{Platform.isTV ? null : (
							<Pressable accessibilityRole="link" accessibilityLabel={`Open ${page}`} onPress={() => void Linking.openURL(link.verifyUrl)} style={[styles.primaryButton, { backgroundColor: theme.accent, alignSelf: 'stretch' }]}>
								<Text style={[styles.primaryButtonText, { color: theme.onAccent }]}>Open {page}</Text>
							</Pressable>
						)}
						<View style={styles.row}>
							<ActivityIndicator color={theme.muted} />
							<Text style={[styles.detailMeta, { color: theme.muted, marginTop: 0 }]}>Waiting for approval…</Text>
						</View>
					</View>
				</View>
			) : null}
			{shown ? <Text style={[styles.inlineError, { color: theme.danger }]}>{shown}</Text> : null}
			{footer}
		</View>
	);
}

/** The DMM web Settings that apply to the app, under the same keys so they follow you across devices. */
export function SettingsScreen() {
	const theme = useAppTheme();
	const { wide } = useLayout();
	const { snapshot, trakt, simkl, trackersAvailable } = useApp();
	const [settings, setSettings] = useState<AppSettings>({});
	const [picking, setPicking] = useState<SettingName | null>(null);
	useEffect(() => {
		const load = () => void loadSettings().then(setSettings);
		load();
		return onSettingsChange(load);
	}, []);
	// New-episode alerts: null until read; `allowed` is the system's permission, which can be withdrawn there.
	const [alerts, setAlertsState] = useState<boolean | null>(null);
	const [allowed, setAllowed] = useState(true);
	useEffect(() => {
		if (!alertsSupported) return;
		const read = () => void Promise.all([alertsOn(), alertsAllowed()]).then(([enabled, ok]) => (setAlertsState(enabled), setAllowed(ok))).catch(() => undefined);
		read();
		const subscription = AppState.addEventListener('change', (state) => state === 'active' && read());
		return () => subscription.remove();
	}, []);
	const switchAlerts = async (enable: boolean) => {
		try {
			if (!(await setAlerts(enable))) {
				setAllowed(false);
				return Alert.alert('Notifications are off for DMM Mobile', 'Allow notifications for DMM Mobile in the system settings, then switch alerts on again.', [
					{ text: 'Not now', style: 'cancel' },
					{ text: 'Open settings', onPress: () => void Linking.openSettings() },
				]);
			}
			setAlertsState(enable);
			setAllowed(true);
		} catch (caught) {
			Alert.alert('Could not change alerts', caught instanceof Error ? caught.message : String(caught));
		}
	};
	const updates = Updates.useUpdates();
	const [checking, setChecking] = useState(false);
	// Get fixes automatically: null until read.
	const [autoFixes, setAutoFixesState] = useState<boolean | null>(null);
	useEffect(() => void (Updates.isEnabled && autoFixesOn().then(setAutoFixesState)), []);
	const switchAutoFixes = (on: boolean) => void setAutoFixes(on).then(() => setAutoFixesState(on), (caught) => Alert.alert('Could not save the setting', caught instanceof Error ? caught.message : String(caught)));
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

	// With fixes on, the app also checks on every start and applies a downloaded update on the next one; this is for a TV left running.
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

	const scroller = useRef<ScrollViewInstance>(null);
	const reveal = useCallback((y: number) => scroller.current?.scrollTo({ y: Math.max(0, y - 12) }), []);

	return (
		<Screen>
			<ScrollView ref={scroller} contentContainerStyle={[styles.content, wide && styles.contentWide]}>
				<Text style={[styles.heading, { color: theme.text }]}>Settings</Text>
				{row('Open videos with', `Built-in plays videos in the app. A player app chosen here is used on DMM web too.${Platform.isTV ? '' : ' Subtitle and other files open in the browser.'}`, <DropdownChip label={player.label} active={player.id !== players[0].id} onPress={() => setPicking('player')} />)}
				{row('Add to', 'The provider the Add screen and magnet links from other apps start on.', <DropdownChip label={addProvider ? PROVIDER_META[addProvider].label : 'First connected'} active={Boolean(addProvider)} onPress={() => setPicking('addProvider')} />)}
				{/* The demo key alone never reaches a tracker. */}
				{trakt && trackersAvailable ? (
					<TrackerRow
						tracker={trakt}
						account={trakt.account}
						start={startTraktLink}
						poll={pollTraktLink}
						signedOut="Scrobble what you play and keep watched marks and resume points in step with Trakt and your other devices. A Trakt login made on DMM web is used by itself."
						footer={<Text style={[styles.detailMeta, { color: theme.muted, marginTop: 0 }]}>DMM Mobile uses Trakt but is not endorsed or certified by Trakt.</Text>}
						reveal={reveal}
					/>
				) : null}
				{simkl && trackersAvailable ? (
					<TrackerRow
						tracker={simkl}
						account={simkl.account}
						start={startSimklLink}
						poll={pollSimklLink}
						signedOut="Scrobble what you play and keep watched marks and resume points in step with Simkl and your other devices. Each device connects to Simkl on its own."
						reveal={reveal}
						// Simkl's API rules: name Simkl where its data shows and link to it.
						footer={
							Platform.isTV ? (
								<Text style={[styles.detailMeta, { color: theme.muted, marginTop: 0 }]}>Watch history synced with Simkl, simkl.com. DMM Mobile is not affiliated with Simkl.</Text>
							) : (
								<Pressable accessibilityRole="link" accessibilityLabel="Open simkl.com" onPress={() => void Linking.openURL('https://simkl.com')}>
									<Text style={[styles.detailMeta, { color: theme.accent, marginTop: 0 }]}>Watch history synced with Simkl, simkl.com. DMM Mobile is not affiliated with Simkl.</Text>
								</Pressable>
							)
						}
					/>
				) : null}
				{/* A TV is seldom in a pocket: alerts are for phones and tablets. */}
				{alertsSupported && alerts !== null
					? row(
							'New-episode alerts',
							alerts && !allowed
								? 'On, but notifications are turned off for DMM Mobile in the system settings, so none show.'
								: 'A notification when an episode of your shows airs (the Calendar on Home). Set on this device each time the app updates the calendar; no server sends anything.',
							<Switch accessibilityLabel="New-episode alerts" value={alerts} onValueChange={(next) => void switchAlerts(next)} trackColor={{ true: theme.accent, false: theme.border }} thumbColor={Platform.OS === 'android' ? theme.surface : undefined} />
						)
					: null}
				{row('Remembered across devices', 'Always on in the app. Sign in to any one provider here or on DMM web with "Remember my logins and settings across devices", and your other logins and these settings come back. Anyone who can sign in to one of those accounts gets all of them, so do not use a shared debrid account.', <Text style={{ color: theme.accent, fontWeight: '700' }}>On</Text>)}
				{autoFixes !== null
					? row(
							'Get fixes automatically',
							'Downloads small updates to the app from debridmediamanager.com and uses them from the next start. They come straight from us, without the checks of the store or repository you installed DMM Mobile from.',
							<Switch accessibilityLabel="Get fixes automatically" value={autoFixes} onValueChange={switchAutoFixes} trackColor={{ true: theme.accent, false: theme.border }} thumbColor={Platform.OS === 'android' ? theme.surface : undefined} />
						)
					: null}
				{row(`Version ${Updates.runtimeVersion ?? ''}`.trim(), updates.isUpdatePending ? `${versionDetail} An update is ready.` : versionDetail, Updates.isEnabled ? <FilterButton label={updates.isUpdatePending ? 'Restart' : checking ? 'Checking…' : 'Check'} active={updates.isUpdatePending} onPress={() => void (checking ? undefined : updateApp())} /> : null)}
				{/* A TV has no browser, so it shows where the pages are. */}
				{[['Privacy policy', '/privacy'], ['Help and support', '/support']].map(([title, path]) => <Fragment key={path}>{row(title, Platform.isTV ? `${OFFICIAL_DMM_ORIGIN.replace('https://', '')}${path}` : 'Opens on debridmediamanager.com.', Platform.isTV ? null : (
					<Pressable accessibilityRole="link" accessibilityLabel={title} onPress={() => void Linking.openURL(`${OFFICIAL_DMM_ORIGIN}${path}`)} style={[styles.outlineButton, { borderColor: theme.accent }]}>
						<Text style={[styles.outlineButtonText, { color: theme.accent }]}>Open</Text>
					</Pressable>
				))}</Fragment>)}
			</ScrollView>
			{picking ? <ActionSheet title={picking === 'player' ? 'Open videos with' : 'Add to'} actions={options[picking]} onClose={() => setPicking(null)} /> : null}
		</Screen>
	);
}
