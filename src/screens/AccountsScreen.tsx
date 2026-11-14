import { useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native';
import type { StoredCredential } from '../auth';
import { useApp } from '../AppContext';
import { PROVIDERS, PROVIDER_META, type ProviderId } from '../model';
import { saveDmmOrigin } from '../settings';
import { useAppTheme } from '../theme';
import { checkDmmServer, DMM_ORIGIN, normalizeDmmOrigin, OFFICIAL_DMM_ORIGIN } from '../tvLink';
import { CredentialInput, ErrorBanner, Pressable, Screen, styles, TextField, TvLinkPanel, useLayout } from '../ui';

export function AccountsScreen() {
	const theme = useAppTheme();
	const { wide } = useLayout();
	const { ready, startupError, snapshot, connect, disconnect, retryStartup, linkState } = useApp();
	const signedIn = PROVIDERS.some((provider) => snapshot.connected[provider]);
	// A TV can also take a key typed with the remote: an API key, or the demo key reviewers use.
	const [keyEntry, setKeyEntry] = useState(false);
	// A new server restarts the TV's pairing there.
	const [origin, setOrigin] = useState(DMM_ORIGIN);
	return (
		<Screen>
			<KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
				<ScrollView contentContainerStyle={[styles.content, wide && styles.contentWide]} keyboardShouldPersistTaps="handled">
					<Text style={[styles.heading, { color: theme.text }]}>{signedIn ? 'Accounts' : 'Sign in'}</Text>
					<Text style={[styles.subheading, { color: theme.muted }]}>{Platform.isTV ? 'Link this TV from your phone: no typing with the remote.' : `${signedIn ? 'Connect the providers whose libraries you want to manage.' : 'Sign in to one or more providers to see your DMM library.'} Credentials are checked with a read-only account request and kept in the device secure store.`}</Text>
					{!ready ? <Text style={[styles.detailMeta, { color: theme.muted }]}>Reading secure accounts…</Text> : null}
					{startupError ? <ErrorBanner message={`Secure account storage: ${startupError}`} actionLabel="Retry secure account load" onAction={() => void retryStartup()} busy={!ready} /> : null}
					{snapshot.failures.length > 0 ? <ErrorBanner message={snapshot.failures.map((failure) => `${PROVIDER_META[failure.provider].label}: ${failure.message}`).join('\n')} /> : null}
					{Platform.isTV ? <TvLinkPanel key={origin} onLinked={linkState} signedIn={signedIn} /> : null}
					{Platform.isTV ? (
						<Pressable accessibilityRole="button" accessibilityState={{ expanded: keyEntry }} onPress={() => setKeyEntry((open) => !open)} style={[styles.outlineButton, { borderColor: theme.accent, alignSelf: 'flex-start', marginTop: 8 }]}>
							<Text style={[styles.outlineButtonText, { color: theme.accent }]}>{keyEntry ? 'Hide API keys' : 'Enter an API key instead'}</Text>
						</Pressable>
					) : null}
					{/* On a TV the phone does the signing in; connected providers are listed to disconnect, all of them when typing a key. */}
					{PROVIDERS.filter((provider) => !Platform.isTV || keyEntry || snapshot.connected[provider]).map((provider) => <AccountRow key={provider} provider={provider} connected={snapshot.connected[provider]} label={snapshot.labels[provider]} error={snapshot.failures.find((failure) => failure.provider === provider)?.message} onConnect={(credential) => connect(provider, credential)} onDisconnect={() => new Promise<void>((resolve) => Alert.alert(`Disconnect ${PROVIDER_META[provider].label}?`, 'The saved credential and this provider’s in-memory library rows will be deleted.', [{ text: 'Cancel', style: 'cancel', onPress: () => resolve() }, { text: 'Disconnect', style: 'destructive', onPress: () => { void disconnect(provider).catch((caught) => Alert.alert('Disconnect failed', caught instanceof Error ? caught.message : 'Could not disconnect this provider.')).finally(resolve); } }]))} busy={snapshot.loading[provider]} />)}
					<DmmServer origin={origin} onSaved={setOrigin} />
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


/** debridmediamanager.com, or a self-hosted DMM: sign-in sync, TV linking, titles and Trakt all go there. */
function DmmServer({ origin, onSaved }: { origin: string; onSaved: (origin: string) => void }) {
	const theme = useAppTheme();
	const [text, setText] = useState(origin === OFFICIAL_DMM_ORIGIN ? '' : origin);
	const [error, setError] = useState('');
	const [saving, setSaving] = useState(false);
	const save = async () => {
		setSaving(true);
		setError('');
		try {
			const next = normalizeDmmOrigin(text);
			// Checked first: the logins are pushed to it as soon as it is saved.
			if (next !== OFFICIAL_DMM_ORIGIN) await checkDmmServer(next);
			onSaved(await saveDmmOrigin(next));
			setText(next === OFFICIAL_DMM_ORIGIN ? '' : next);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : 'Could not use that server.');
		} finally {
			setSaving(false);
		}
	};
	const changed = normalizeOrNull(text) !== origin;
	return (
		<View style={[styles.accountCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
			<Text style={[styles.accountTitle, { color: theme.text }]}>DMM server</Text>
			<Text style={[styles.subheading, { color: theme.muted, marginTop: 0 }]}>Leave blank for debridmediamanager.com, or enter your own DMM's address. Logins and settings sync through it.</Text>
			<TextField accessibilityLabel="DMM server address" value={text} onChangeText={setText} onSubmitEditing={() => void save()} placeholder="debridmediamanager.com" autoCapitalize="none" autoCorrect={false} keyboardType="url" inputMode="url" style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.text }]} />
			{error ? <Text style={[styles.inlineError, { color: theme.danger }]}>{error}</Text> : null}
			{changed ? (
				<Pressable accessibilityRole="button" accessibilityLabel="Use this DMM server" onPress={() => void save()} disabled={saving} style={[styles.outlineButton, { borderColor: theme.accent, alignSelf: 'flex-start' }]}>
					<Text style={[styles.outlineButtonText, { color: theme.accent }]}>{saving ? 'Checking…' : 'Use this server'}</Text>
				</Pressable>
			) : null}
		</View>
	);
}

const normalizeOrNull = (text: string) => {
	try {
		return normalizeDmmOrigin(text);
	} catch {
		return null;
	}
};
