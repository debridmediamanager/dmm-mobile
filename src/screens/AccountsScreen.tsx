import { useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native';
import type { StoredCredential } from '../auth';
import { useApp } from '../AppContext';
import { PROVIDERS, PROVIDER_META, type ProviderId } from '../model';
import { useAppTheme } from '../theme';
import { CredentialInput, ErrorBanner, Screen, styles, TvLinkPanel, useLayout } from '../ui';

export function AccountsScreen() {
	const theme = useAppTheme();
	const { wide } = useLayout();
	const { ready, startupError, snapshot, connect, disconnect, retryStartup, linkState } = useApp();
	const signedIn = PROVIDERS.some((provider) => snapshot.connected[provider]);
	return (
		<Screen>
			<KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
				<ScrollView contentContainerStyle={[styles.content, wide && styles.contentWide]} keyboardShouldPersistTaps="handled">
					<Text style={[styles.heading, { color: theme.text }]}>{signedIn ? 'Accounts' : 'Sign in'}</Text>
					<Text style={[styles.subheading, { color: theme.muted }]}>{Platform.isTV ? 'Link this TV from your phone: no typing with the remote.' : `${signedIn ? 'Connect the providers whose libraries you want to manage.' : 'Sign in to one or more providers to see your DMM library.'} Credentials are checked with a read-only account request and kept in the device secure store.`}</Text>
					{!ready ? <Text style={[styles.detailMeta, { color: theme.muted }]}>Reading secure accounts…</Text> : null}
					{startupError ? <ErrorBanner message={`Secure account storage: ${startupError}`} actionLabel="Retry secure account load" onAction={() => void retryStartup()} busy={!ready} /> : null}
					{snapshot.failures.length > 0 ? <ErrorBanner message={snapshot.failures.map((failure) => `${PROVIDER_META[failure.provider].label}: ${failure.message}`).join('\n')} /> : null}
					{Platform.isTV ? <TvLinkPanel onLinked={linkState} signedIn={signedIn} /> : null}
					{/* On a TV the phone does the signing in; only connected providers are listed, to disconnect. */}
					{PROVIDERS.filter((provider) => !Platform.isTV || snapshot.connected[provider]).map((provider) => <AccountRow key={provider} provider={provider} connected={snapshot.connected[provider]} label={snapshot.labels[provider]} error={snapshot.failures.find((failure) => failure.provider === provider)?.message} onConnect={(credential) => connect(provider, credential)} onDisconnect={() => new Promise<void>((resolve) => Alert.alert(`Disconnect ${PROVIDER_META[provider].label}?`, 'The saved credential and this provider’s in-memory library rows will be deleted.', [{ text: 'Cancel', style: 'cancel', onPress: () => resolve() }, { text: 'Disconnect', style: 'destructive', onPress: () => { void disconnect(provider).catch((caught) => Alert.alert('Disconnect failed', caught instanceof Error ? caught.message : 'Could not disconnect this provider.')).finally(resolve); } }]))} busy={snapshot.loading[provider]} />)}
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

