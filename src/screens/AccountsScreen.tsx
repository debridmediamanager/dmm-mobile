import { useEffect, useState } from 'react';
import { Alert, KeyboardAvoidingView, ScrollView, Text, View } from 'react-native';
import type { StoredCredential } from '../auth';
import { useApp } from '../AppContext';
import { PROVIDERS, PROVIDER_META, type ProviderId } from '../model';
import { useAppTheme } from '../theme';
import { ActionSheet, CredentialInput, DropdownChip, ErrorBanner, Screen, styles } from '../ui';
import { loadPlayer, playersForPlatform, savePlayer } from '../player';

export function AccountsScreen() {
	const theme = useAppTheme();
	const { ready, startupError, snapshot, connect, disconnect, retryStartup } = useApp();
	const signedIn = PROVIDERS.some((provider) => snapshot.connected[provider]);
	return (
		<Screen>
			<KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
				<ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
					<Text style={[styles.heading, { color: theme.text }]}>{signedIn ? 'Accounts' : 'Sign in'}</Text>
					<Text style={[styles.subheading, { color: theme.muted }]}>{signedIn ? 'Connect the providers whose libraries you want to manage.' : 'Sign in to one or more providers to see your DMM library.'} Credentials are checked with a read-only account request and kept in the device secure store.</Text>
					{!ready ? <Text style={[styles.detailMeta, { color: theme.muted }]}>Reading secure accounts…</Text> : null}
					{startupError ? <ErrorBanner message={`Secure account storage: ${startupError}`} actionLabel="Retry secure account load" onAction={() => void retryStartup()} busy={!ready} /> : null}
					{snapshot.failures.length > 0 ? <ErrorBanner message={snapshot.failures.map((failure) => `${PROVIDER_META[failure.provider].label}: ${failure.message}`).join('\n')} /> : null}
					{signedIn ? <PlayerSetting /> : null}
					{PROVIDERS.map((provider) => <AccountRow key={provider} provider={provider} connected={snapshot.connected[provider]} label={snapshot.labels[provider]} error={snapshot.failures.find((failure) => failure.provider === provider)?.message} onConnect={(credential) => connect(provider, credential)} onDisconnect={() => new Promise<void>((resolve) => Alert.alert(`Disconnect ${PROVIDER_META[provider].label}?`, 'The saved credential and this provider’s in-memory library rows will be deleted.', [{ text: 'Cancel', style: 'cancel', onPress: () => resolve() }, { text: 'Disconnect', style: 'destructive', onPress: () => { void disconnect(provider).catch((caught) => Alert.alert('Disconnect failed', caught instanceof Error ? caught.message : 'Could not disconnect this provider.')).finally(resolve); } }]))} busy={snapshot.loading[provider]} />)}
				</ScrollView>
			</KeyboardAvoidingView>
		</Screen>
	);
}

function AccountRow({
	provider,
	connected,
	label,
	error,
	onConnect,
	onDisconnect,
	busy,
}: {
	provider: ProviderId;
	connected: boolean;
	label?: string;
	error?: string;
	onConnect: (credential: string | StoredCredential) => Promise<void>;
	onDisconnect: () => Promise<void>;
	busy: boolean;
}) {
	const [working, setWorking] = useState(false);
	const run = async (operation: () => Promise<void>) => {
		setWorking(true);
		try {
			await operation();
		} finally {
			setWorking(false);
		}
	};
	return <CredentialInput provider={provider} connected={connected} label={label} error={error} busy={working || busy} onConnect={(credential) => run(() => onConnect(credential))} onDisconnect={() => run(onDisconnect)} />;
}

/** Which app opens a video file; other files still go to the system. */
function PlayerSetting() {
	const theme = useAppTheme();
	const [player, setPlayer] = useState('browser');
	const [choosing, setChoosing] = useState(false);
	useEffect(() => {
		void loadPlayer().then(setPlayer);
	}, []);
	const options = playersForPlatform();
	const choose = (id: string) => {
		setPlayer(id);
		void savePlayer(id).catch((caught) => Alert.alert('Could not save the player', caught instanceof Error ? caught.message : String(caught)));
	};
	return (
		<View style={[styles.accountCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
			<View style={styles.rowBetween}>
				<Text style={[styles.accountTitle, { color: theme.text }]}>Open videos with</Text>
				<DropdownChip label={options.find((option) => option.id === player)?.label ?? 'Browser'} active={player !== 'browser'} onPress={() => setChoosing(true)} />
			</View>
			<Text style={[styles.subheading, { color: theme.muted, marginTop: 0 }]}>Used when you open a video file. Subtitles and other files still open in the browser.</Text>
			{choosing ? <ActionSheet title="Open videos with" actions={options.map((option) => ({ label: `${option.id === player ? '✓ ' : ''}${option.label}`, onPress: () => choose(option.id) }))} onClose={() => setChoosing(false)} /> : null}
		</View>
	);
}
