import { memo, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ActivityIndicator, Linking, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';
import { startDeviceLogin, supportsDeviceLogin, waitForApproval, type DeviceLogin, type StoredCredential } from './auth';
import type { LibraryItem, MediaType, ProviderId } from './model';
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

const MEDIA_LABEL = { movie: 'Movie', tv: 'TV', other: 'Other' } as const;
const SHORT_PROVIDER = { rd: 'RD', ad: 'AD', tb: 'TB', pm: 'PM', oc: 'OC', dl: 'DL' } as const;
/** Every row is this tall, so the list can jump and scroll thousands without measuring. */
export const ROW_HEIGHT = 54;

/** One dense library row, like a DMM web table row: name, then provider, size, type, state and date. */
export const LibraryRow = memo(function LibraryRow({
	item,
	mediaType,
	selected,
	selecting,
	hashCount,
	titleCount,
	onPress,
	onLongPress,
	onMore,
}: {
	item: LibraryItem;
	mediaType: MediaType;
	selected: boolean;
	selecting: boolean;
	/** Copies of this hash on its provider, and rows of this title; shown as chips when above 1. */
	hashCount: number;
	titleCount: number;
	onPress: (item: LibraryItem) => void;
	onLongPress: (item: LibraryItem) => void;
	onMore: (item: LibraryItem) => void;
}) {
	const theme = useAppTheme();
	const meta = PROVIDER_META[item.provider];
	const live = item.status === 'downloading' && item.speed ? ` · ${formatBytes(item.speed)}/s · ${item.seeders ?? 0} seeds` : '';
	const state = item.status === 'finished' ? '' : ` · ${Math.round(item.progress)}% ${item.serviceStatus}`;
	return (
		<Pressable
			accessibilityRole={selecting ? 'checkbox' : 'button'}
			accessibilityState={selecting ? { checked: selected } : undefined}
			accessibilityLabel={selecting ? `Select ${item.title}` : `Open ${item.title}`}
			accessibilityHint={selecting ? undefined : 'Long press to select'}
			onPress={() => onPress(item)}
			onLongPress={() => onLongPress(item)}
			style={({ pressed }) => [styles.row, { height: ROW_HEIGHT, paddingLeft: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border, backgroundColor: selected ? theme.input : pressed ? theme.surface : theme.background }]}
		>
			{selecting ? <Text style={{ color: selected ? theme.accent : theme.muted, fontSize: 16, fontWeight: '700', width: 18 }}>{selected ? '✓' : '○'}</Text> : null}
			<View style={{ flex: 1, justifyContent: 'center' }}>
				<Text numberOfLines={1} style={{ color: item.status === 'error' ? theme.danger : theme.text, fontSize: 13.5, fontWeight: '600' }}>{item.title}</Text>
				<View style={[styles.row, { gap: 6, marginTop: 2 }]}>
					<View style={{ backgroundColor: meta.color, borderRadius: 4, paddingHorizontal: 4 }}><Text style={{ fontSize: 10, fontWeight: '800', color: item.provider === 'tb' || item.provider === 'pm' ? '#fff' : '#111827' }}>{SHORT_PROVIDER[item.provider]}</Text></View>
					<Text numberOfLines={1} style={{ flexShrink: 1, color: theme.muted, fontSize: 11.5 }}>
						{formatBytes(item.size).replace('Unknown size', '—')} · {MEDIA_LABEL[mediaType]} · {new Date(item.added).toLocaleDateString()}{state}{live}
					</Text>
					{/* Plain text: a tappable marker sat where a thumb opens the row. The ⋯ menu opens these groups. */}
					{hashCount > 1 ? <Text style={{ color: '#f97316', fontSize: 11, fontWeight: '700' }}>{hashCount}× hash</Text> : null}
					{titleCount > 1 ? <Text style={{ color: '#f59e0b', fontSize: 11, fontWeight: '700' }}>{titleCount}× title</Text> : null}
				</View>
				{item.status !== 'finished' ? <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 2, backgroundColor: theme.border }}><View style={{ height: 2, width: `${Math.max(0, Math.min(100, item.progress))}%`, backgroundColor: theme.accent }} /></View> : null}
			</View>
			<Pressable accessibilityRole="button" accessibilityLabel={`More for ${item.title}`} onPress={() => onMore(item)} style={{ width: 40, height: ROW_HEIGHT, alignItems: 'center', justifyContent: 'center' }}>
				<Text style={{ color: theme.muted, fontSize: 20, fontWeight: '700' }}>⋯</Text>
			</Pressable>
		</Pressable>
	);
});

/** A compact dropdown chip: shows the current choice and opens a sheet of options. */
export function DropdownChip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
	const theme = useAppTheme();
	return (
		<Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={{ height: 32, paddingHorizontal: 10, borderRadius: 16, borderWidth: 1, justifyContent: 'center', borderColor: active ? theme.accent : theme.border, backgroundColor: active ? theme.accent : theme.surface }}>
			<Text numberOfLines={1} style={{ fontSize: 13, fontWeight: '600', color: active ? theme.onAccent : theme.text }}>{label} ▾</Text>
		</Pressable>
	);
}

export interface SheetAction {
	label: string;
	onPress: () => void;
	destructive?: boolean;
}

/** A bottom sheet of actions; Android alerts hold three buttons at most. */
export function ActionSheet({ title, detail, actions, onClose }: { title: string; detail?: string; actions: SheetAction[]; onClose: () => void }) {
	const theme = useAppTheme();
	return (
		<Modal visible animationType="slide" transparent onRequestClose={onClose}>
			<Pressable style={styles.modalBackdrop} onPress={onClose} accessibilityLabel="Close actions">
				<Pressable style={[styles.modalSheet, { backgroundColor: theme.surface }]} onPress={() => undefined}>
					<View style={styles.rowBetween}>
						<Text style={[styles.modalTitle, { color: theme.text }]}>{title}</Text>
						<Pressable accessibilityRole="button" accessibilityLabel="Close actions" onPress={onClose}><Text style={{ color: theme.accent, fontWeight: '700' }}>Close</Text></Pressable>
					</View>
					{detail ? <Text style={[styles.subheading, { color: theme.muted }]}>{detail}</Text> : null}
					<ScrollView style={{ maxHeight: 460 }} contentContainerStyle={{ gap: 8 }}>
						{actions.map((action) => (
							<Pressable key={action.label} accessibilityRole="button" accessibilityLabel={action.label} onPress={() => { onClose(); action.onPress(); }} style={[styles.outlineButton, { borderColor: action.destructive ? theme.danger : theme.border, minHeight: 46 }]}>
								<Text style={[styles.outlineButtonText, { color: action.destructive ? theme.danger : theme.text, fontSize: 15 }]}>{action.label}</Text>
							</Pressable>
						))}
					</ScrollView>
				</Pressable>
			</Pressable>
		</Modal>
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
