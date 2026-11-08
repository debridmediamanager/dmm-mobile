import { useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native';
import { useApp } from '../AppContext';
import { PROVIDERS, PROVIDER_META, type ProviderId } from '../model';
import { useAppTheme } from '../theme';
import { CredentialInput, ErrorBanner, Screen, styles } from '../ui';

export function AccountsScreen() {
	const theme = useAppTheme();
	const { ready, startupError, snapshot, connect, disconnect, retryStartup } = useApp();
	return (
		<Screen>
			<KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
				<ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
					<Text style={[styles.heading, { color: theme.text }]}>Accounts</Text>
					<Text style={[styles.subheading, { color: theme.muted }]}>Connect the providers whose libraries you want to manage. Keys are checked with a read-only account request and stored in the device secure store.</Text>
					{!ready ? <Text style={[styles.detailMeta, { color: theme.muted }]}>Reading secure accounts…</Text> : null}
					{startupError ? <ErrorBanner message={`Secure account storage: ${startupError}`} actionLabel="Retry secure account load" onAction={() => void retryStartup()} busy={!ready} /> : null}
					{snapshot.failures.length > 0 ? <ErrorBanner message={snapshot.failures.map((failure) => `${PROVIDER_META[failure.provider].label}: ${failure.message}`).join('\n')} /> : null}
					{PROVIDERS.map((provider) => <AccountRow key={provider} provider={provider} connected={snapshot.connected[provider]} label={snapshot.labels[provider]} error={snapshot.failures.find((failure) => failure.provider === provider)?.message} onConnect={(token) => connect(provider, token)} onDisconnect={() => new Promise<void>((resolve) => Alert.alert(`Disconnect ${PROVIDER_META[provider].label}?`, 'The saved credential and this provider’s in-memory library rows will be deleted.', [{ text: 'Cancel', style: 'cancel', onPress: () => resolve() }, { text: 'Disconnect', style: 'destructive', onPress: () => { void disconnect(provider).catch((caught) => Alert.alert('Disconnect failed', caught instanceof Error ? caught.message : 'Could not disconnect this provider.')).finally(resolve); } }]))} busy={snapshot.loading[provider]} />)}
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
	onConnect: (token: string) => Promise<void>;
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
	return <CredentialInput provider={provider} connected={connected} label={label} error={error} busy={working || busy} onConnect={(token) => run(() => onConnect(token))} onDisconnect={() => run(onDisconnect)} />;
}
