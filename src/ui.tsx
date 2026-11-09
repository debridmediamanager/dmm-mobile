import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';
import { startDeviceLogin, supportsDeviceLogin, waitForApproval, type DeviceLogin, type StoredCredential } from './auth';
import type { LibraryItem, ProviderId } from './model';
import { PROVIDER_META, statusLabel } from './model';
import { formatBytes } from './core';
import { useAppTheme } from './theme';

export function Screen({ children, edges = ['top', 'bottom'] }: { children: ReactNode; edges?: Edge[] }) {
	const theme = useAppTheme();
	return <SafeAreaView edges={edges} style={[styles.screen, { backgroundColor: theme.background }]}>{children}</SafeAreaView>;
}

export function EmptyState({ title, detail }: { title: string; detail?: string }) {
	const theme = useAppTheme();
	return (
		<View style={styles.empty}>
			<Text style={[styles.emptyTitle, { color: theme.text }]}>{title}</Text>
			{detail ? <Text style={[styles.emptyDetail, { color: theme.muted }]}>{detail}</Text> : null}
		</View>
	);
}

export function ErrorBanner({ message, actionLabel, onAction, busy = false }: { message: string; actionLabel?: string; onAction?: () => void; busy?: boolean }) {
	const theme = useAppTheme();
	return (
		<View style={[styles.errorBanner, { backgroundColor: theme.dark ? '#3b1d2a' : '#fff0ef', borderColor: theme.danger }]}>
			<Text style={[styles.errorText, { color: theme.danger }]}>{message}</Text>
			{actionLabel && onAction ? <Pressable accessibilityRole="button" accessibilityLabel={actionLabel} onPress={onAction} disabled={busy} style={[styles.outlineButton, { borderColor: theme.danger, alignSelf: 'flex-start', marginTop: 8 }]}><Text style={[styles.outlineButtonText, { color: theme.danger }]}>{busy ? 'Retrying…' : actionLabel}</Text></Pressable> : null}
		</View>
	);
}

export function FilterButton({
	label,
	active,
	onPress,
	}: {
	label: string;
	active: boolean;
	onPress: () => void;
}) {
	const theme = useAppTheme();
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityState={{ selected: active }}
			style={[styles.filterButton, { borderColor: active ? theme.accent : theme.border, backgroundColor: active ? theme.accent : theme.surface }]}
			onPress={onPress}
		>
			<Text style={[styles.filterText, { color: active ? theme.onAccent : theme.text }]}>{label}</Text>
		</Pressable>
	);
}

export function ProviderBadge({ provider }: { provider: ProviderId }) {
	const meta = PROVIDER_META[provider];
	return (
		<View style={[styles.providerBadge, { backgroundColor: meta.color }]}>
			<Text style={[styles.providerBadgeText, { color: provider === 'tb' || provider === 'pm' ? '#fff' : '#111827' }]}>{meta.label}</Text>
		</View>
	);
}

export function LibraryCard({
	item,
	onPress,
	onShare,
}: {
	item: LibraryItem;
	onPress: () => void;
	onShare: () => void;
}) {
	const theme = useAppTheme();
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel={`Open ${item.title}`}
			style={({ pressed }) => [styles.card, { backgroundColor: theme.surface, borderColor: theme.border, opacity: pressed ? 0.82 : 1 }]}
			onPress={onPress}
		>
			<View style={styles.rowBetween}>
				<ProviderBadge provider={item.provider} />
				<Pressable accessibilityRole="button" accessibilityLabel={`Share ${item.title} magnet`} onPress={onShare} hitSlop={10}>
					<Text style={[styles.share, { color: theme.accent }]}>Share magnet</Text>
				</Pressable>
			</View>
			<Text numberOfLines={2} style={[styles.cardTitle, { color: theme.text }]}>{item.title}</Text>
			<Text numberOfLines={1} style={[styles.cardFilename, { color: theme.muted }]}>{item.filename}</Text>
			<View style={styles.rowBetween}>
				<Text style={[styles.cardMeta, { color: theme.muted }]}>{statusLabel(item.status)} · {formatBytes(item.size)}</Text>
				<Text style={[styles.cardMeta, { color: theme.muted }]}>{Math.round(item.progress)}%</Text>
			</View>
			<View style={[styles.progressTrack, { backgroundColor: theme.border }]}>
				<View style={[styles.progressFill, { width: `${Math.max(0, Math.min(100, item.progress))}%`, backgroundColor: theme.accent }]} />
			</View>
		</Pressable>
	);
}

export function CredentialInput({
	provider,
	connected,
	label,
	onConnect,
	onDisconnect,
	busy,
	error,
}: {
	provider: ProviderId;
	connected: boolean;
	label?: string;
	onConnect: (credential: string | StoredCredential) => Promise<void>;
	onDisconnect: () => Promise<void>;
	busy: boolean;
	error?: string;
}) {
	const theme = useAppTheme();
	const [token, setToken] = useState('');
	const [localError, setLocalError] = useState('');
	const [device, setDevice] = useState<DeviceLogin | null>(null);
	const [starting, setStarting] = useState(false);
	const waiting = useRef<AbortController | null>(null);
	useEffect(() => () => waiting.current?.abort(), []);
	const meta = PROVIDER_META[provider];
	const submit = async () => {
		setLocalError('');
		try {
			await onConnect(token);
			setToken('');
		} catch (caught) {
			setLocalError(caught instanceof Error ? caught.message : 'Could not connect.');
		}
	};
	const signIn = async () => {
		if (!supportsDeviceLogin(provider)) return;
		setLocalError('');
		setStarting(true);
		const controller = new AbortController();
		waiting.current?.abort();
		waiting.current = controller;
		try {
			const login = await startDeviceLogin(provider);
			if (controller.signal.aborted) return;
			setDevice(login);
			void Linking.openURL(login.verificationUrl).catch(() => undefined);
			const credential = await waitForApproval(login, controller.signal);
			if (!credential) return;
			await onConnect(credential);
		} catch (caught) {
			if (!controller.signal.aborted) setLocalError(caught instanceof Error ? caught.message : 'Could not sign in.');
		} finally {
			if (waiting.current === controller) {
				waiting.current = null;
				setDevice(null);
				setStarting(false);
			}
		}
	};
	const cancel = () => {
		waiting.current?.abort();
		waiting.current = null;
		setDevice(null);
		setStarting(false);
	};
	const host = (url: string) => url.replace(/^https?:\/\//, '').split(/[/?]/, 1)[0];
	return (
		<View style={[styles.accountCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
			<View style={styles.rowBetween}>
				<Text style={[styles.accountTitle, { color: theme.text }]}>{meta.label}</Text>
				<Text style={[styles.connected, { color: connected ? '#16803c' : theme.muted }]}>{connected ? 'Connected' : 'Not connected'}</Text>
			</View>
			{connected ? (
				<View style={styles.rowBetween}>
					<Text style={[styles.accountLabel, { color: theme.muted }]}>{label ? `Account: ${label}` : 'Credential saved securely'}</Text>
					<Pressable accessibilityRole="button" accessibilityLabel={`Disconnect ${meta.label}`} onPress={() => void onDisconnect()} disabled={busy} style={[styles.outlineButton, { borderColor: theme.danger }]}>
						{busy ? <ActivityIndicator color={theme.danger} /> : <Text style={[styles.outlineButtonText, { color: theme.danger }]}>Disconnect</Text>}
					</Pressable>
				</View>
			) : device ? (
				<View style={{ gap: 10, alignItems: 'center' }}>
					<Text style={[styles.subheading, { color: theme.muted, textAlign: 'center' }]}>Approve this code on {host(device.verificationUrl)}:</Text>
					<Text selectable accessibilityLabel={`${meta.label} sign-in code ${device.userCode}`} style={[styles.deviceCode, { color: theme.text }]}>{device.userCode}</Text>
					<Pressable accessibilityRole="link" accessibilityLabel={`Open ${host(device.verificationUrl)}`} onPress={() => void Linking.openURL(device.verificationUrl)} style={[styles.primaryButton, { backgroundColor: theme.accent, alignSelf: 'stretch' }]}>
						<Text style={[styles.primaryButtonText, { color: theme.onAccent }]}>Open {host(device.verificationUrl)}</Text>
					</Pressable>
					<View style={styles.row}>
						<ActivityIndicator color={theme.muted} />
						<Text style={[styles.detailMeta, { color: theme.muted, marginTop: 0 }]}>{busy ? 'Signed in, checking the account…' : 'Waiting for approval…'}</Text>
					</View>
					<Pressable accessibilityRole="button" accessibilityLabel={`Cancel ${meta.label} sign-in`} onPress={cancel} hitSlop={8}>
						<Text style={{ color: theme.accent, fontWeight: '700' }}>Cancel</Text>
					</Pressable>
				</View>
			) : (
				<>
					{supportsDeviceLogin(provider) ? (
						<>
							<Pressable accessibilityRole="button" accessibilityLabel={`Sign in with ${meta.label}`} onPress={() => void signIn()} disabled={busy || starting} style={[styles.primaryButton, { backgroundColor: theme.accent, opacity: busy || starting ? 0.55 : 1 }]}>
								{starting ? <ActivityIndicator color={theme.onAccent} /> : <Text style={[styles.primaryButtonText, { color: theme.onAccent }]}>Sign in with {meta.label}</Text>}
							</Pressable>
							<Text style={[styles.dividerText, { color: theme.muted }]}>or paste an {meta.credentialLabel}</Text>
						</>
					) : null}
					<TextInput
						accessibilityLabel={`${meta.label} ${meta.credentialLabel}`}
						value={token}
						onChangeText={setToken}
						placeholder={meta.credentialLabel}
						placeholderTextColor={theme.muted}
						secureTextEntry
						autoCapitalize="none"
						autoCorrect={false}
						style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.text }]}
					/>
					<View style={styles.row}>
						<Pressable accessibilityRole="button" accessibilityLabel={`Connect ${meta.label}`} onPress={() => void submit()} disabled={busy || !token.trim()} style={[supportsDeviceLogin(provider) ? styles.outlineButton : styles.primaryButton, supportsDeviceLogin(provider) ? { borderColor: theme.accent, flex: 1, alignItems: 'center', minHeight: 44 } : { backgroundColor: theme.accent, flex: 1 }, { opacity: busy || !token.trim() ? 0.55 : 1 }]}>
							{busy ? <ActivityIndicator color={supportsDeviceLogin(provider) ? theme.accent : theme.onAccent} /> : <Text style={[styles.primaryButtonText, { color: supportsDeviceLogin(provider) ? theme.accent : theme.onAccent }]}>Save key</Text>}
						</Pressable>
						<Pressable accessibilityRole="link" accessibilityLabel={`Get a ${meta.label} ${meta.credentialLabel}`} onPress={() => void Linking.openURL(meta.keyUrl)} hitSlop={8}>
							<Text style={{ color: theme.accent, fontWeight: '700' }}>Get key</Text>
						</Pressable>
					</View>
				</>
			)}
			{localError || error ? <Text style={[styles.inlineError, { color: theme.danger }]}>{localError || error}</Text> : null}
		</View>
	);
}

export const styles = StyleSheet.create({
	screen: { flex: 1 },
	content: { padding: 16, paddingBottom: 36 },
	header: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 },
	heading: { fontSize: 28, fontWeight: '700' },
	subheading: { fontSize: 14, marginTop: 4 },
	rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
	row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
	search: { marginTop: 12, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 11, fontSize: 16 },
	filterBar: { flexGrow: 0, flexShrink: 0, height: 52 },
	filterScroll: { paddingHorizontal: 16, paddingVertical: 8 },
	filterButton: { alignSelf: 'flex-start', minHeight: 36, paddingHorizontal: 13, borderRadius: 18, borderWidth: 1, justifyContent: 'center' },
	filterText: { fontSize: 14, fontWeight: '600' },
	card: { marginHorizontal: 16, marginVertical: 6, padding: 14, borderRadius: 14, borderWidth: 1 },
	providerBadge: { alignSelf: 'flex-start', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 },
	providerBadgeText: { fontSize: 12, fontWeight: '700' },
	cardTitle: { fontSize: 17, fontWeight: '700', marginTop: 10 },
	cardFilename: { fontSize: 13, marginTop: 4 },
	cardMeta: { fontSize: 13, marginTop: 10 },
	progressTrack: { height: 5, borderRadius: 4, overflow: 'hidden', marginTop: 8 },
	progressFill: { height: '100%', borderRadius: 4 },
	share: { fontSize: 12, fontWeight: '600' },
	empty: { alignItems: 'center', paddingHorizontal: 24, paddingVertical: 64 },
	emptyTitle: { fontSize: 18, fontWeight: '700', textAlign: 'center' },
	emptyDetail: { fontSize: 14, textAlign: 'center', marginTop: 8, lineHeight: 20 },
	errorBanner: { marginHorizontal: 16, marginVertical: 8, padding: 12, borderWidth: 1, borderRadius: 10 },
	errorText: { fontSize: 14, lineHeight: 20 },
	accountCard: { marginHorizontal: 16, marginVertical: 7, padding: 15, borderRadius: 14, borderWidth: 1, gap: 10 },
	accountTitle: { fontSize: 18, fontWeight: '700' },
	connected: { fontSize: 13, fontWeight: '600' },
	accountLabel: { flex: 1, fontSize: 13 },
	input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 11, fontSize: 16 },
	primaryButton: { alignItems: 'center', justifyContent: 'center', minHeight: 44, borderRadius: 10, paddingHorizontal: 14 },
	primaryButtonText: { fontWeight: '700', fontSize: 15 },
	outlineButton: { minHeight: 38, borderWidth: 1, borderRadius: 9, paddingHorizontal: 10, justifyContent: 'center' },
	outlineButtonText: { fontWeight: '700', fontSize: 13 },
	inlineError: { fontSize: 13, lineHeight: 19 },
	deviceCode: { fontSize: 32, fontWeight: '700', letterSpacing: 4, fontVariant: ['tabular-nums'] },
	dividerText: { fontSize: 12, textAlign: 'center' },
	detailSection: { marginTop: 16, marginHorizontal: 16 },
	detailTitle: { fontSize: 23, fontWeight: '700', marginTop: 12 },
	detailMeta: { fontSize: 14, marginTop: 6 },
	fileRow: { paddingVertical: 12, borderBottomWidth: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
	fileName: { flex: 1, fontSize: 15 },
	fileSize: { fontSize: 12, flexShrink: 0, textAlign: 'right' },
	fileButton: { minHeight: 36, borderRadius: 8, paddingHorizontal: 10, justifyContent: 'center' },
	fileButtonText: { fontSize: 13, fontWeight: '700' },
	modalBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.45)' },
	modalSheet: { borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 18, gap: 12 },
	modalTitle: { fontSize: 21, fontWeight: '700' },
	modalButtonRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
});
