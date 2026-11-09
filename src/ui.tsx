import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ActivityIndicator, Keyboard, Linking, Modal, Platform, Pressable as RNPressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions, type PressableProps, type TextInputInstance, type TextInputProps } from 'react-native';
import qrcode from 'qrcode-generator';
import { SafeAreaView, useSafeAreaInsets, type Edge } from 'react-native-safe-area-context';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { startDeviceLogin, supportsDeviceLogin, waitForApproval, type DeviceLogin, type StoredCredential } from './auth';
import type { LibraryItem, MediaType, ProviderId } from './model';
import { PROVIDER_META, statusLabel } from './model';
import { pollTvPairing, startTvPairing, type TvPairing } from './tvLink';
import type { BrowserState } from './sync';
import { formatBytes } from './core';
import { useAppTheme } from './theme';

/** Apple TV lays out 1920×1080 points where Android TV has 960×540 dp; drawing at half size and scaling by two gives both one layout. */
const TV_SCALE = Platform.OS === 'ios' && Platform.isTV ? 2 : 1;

/** Wraps the app and each modal's content (a modal is a window of its own) in the Apple TV scale. */
export function TvScale({ children }: { children: ReactNode }) {
	const { width, height } = useWindowDimensions();
	if (TV_SCALE === 1) return <>{children}</>;
	return <View style={{ width: width / TV_SCALE, height: height / TV_SCALE, transform: [{ scale: TV_SCALE }], transformOrigin: 'top left' }}>{children}</View>;
}

/** Wide is a tablet or a TV: sheets float in the middle and forms keep a readable width. */
export function useLayout(): { tv: boolean; wide: boolean } {
	const { width } = useWindowDimensions();
	return { tv: Platform.isTV, wide: Platform.isTV || width >= 700 };
}

/** Every button in the app. A TV remote's focus is drawn as an outline inside it: no layout space, and a list row's neighbours cannot cover it. */
export function Pressable({ style, ...props }: PressableProps) {
	const theme = useAppTheme();
	return <RNPressable {...props} style={(state) => [typeof style === 'function' ? style(state) : style, state.focused ? { outlineWidth: 3, outlineStyle: 'solid', outlineOffset: -3, outlineColor: theme.focus } : null]} />;
}

const ANDROID_TV = Platform.OS === 'android' && Platform.isTV;

/**
 * Android TV traps the remote in a focused text field: every D-pad key moves the caret, so focus never
 * leaves (measured on a Fire TV Cube). On a TV the field is therefore reached as a button: Select opens
 * the keyboard, and closing or submitting it releases the field and hands focus back to that button.
 * Apple TV's focus engine moves in and out of text fields itself.
 */
function useTvEditing(onSubmitEditing?: TextInputProps['onSubmitEditing']) {
	const ref = useRef<TextInputInstance>(null);
	const [editing, setEditing] = useState(false);
	const [refocus, setRefocus] = useState(false);
	useEffect(() => {
		if (!editing) return undefined;
		// Next frame: the field turns focusable in this commit, and Android refuses focus until that lands.
		const timer = setTimeout(() => ref.current?.focus(), 50);
		const subscription = Keyboard.addListener('keyboardDidHide', () => ref.current?.blur());
		return () => {
			clearTimeout(timer);
			subscription.remove();
		};
	}, [editing]);
	return {
		ref,
		/** Props for the wrapping button; undefined off TV, where the field is used directly. */
		button: ANDROID_TV ? { onPress: () => { setRefocus(false); setEditing(true); }, hasTVPreferredFocus: refocus } : undefined,
		input: ANDROID_TV
			? {
					focusable: editing,
					onSubmitEditing: (event: Parameters<NonNullable<TextInputProps['onSubmitEditing']>>[0]) => {
						onSubmitEditing?.(event);
						ref.current?.blur();
					},
				}
			: { onSubmitEditing },
		ended: () => {
			if (!editing) return;
			setEditing(false);
			setRefocus(true);
		},
	};
}

/** A text field whose border lights up while it has focus, so a TV remote shows where typing goes. */
export function TextField({ style, onFocus, onBlur, onSubmitEditing, ...props }: TextInputProps) {
	const theme = useAppTheme();
	const [focused, setFocused] = useState(false);
	const tv = useTvEditing(onSubmitEditing);
	const field = <TextInput ref={tv.ref} placeholderTextColor={theme.muted} {...props} {...tv.input} onFocus={(event) => { setFocused(true); onFocus?.(event); }} onBlur={(event) => { setFocused(false); tv.ended(); onBlur?.(event); }} style={[style, focused && { borderColor: theme.focus, borderWidth: 2 }]} />;
	return tv.button ? <Pressable accessibilityRole="button" accessibilityLabel={props.accessibilityLabel} {...tv.button} style={{ borderRadius: 10 }}>{field}</Pressable> : field;
}

/** A QR code drawn with Views, one strip per run of dark modules; a TV shows it so a phone can approve a sign-in. */
export function QrCode({ value, size = 200 }: { value: string; size?: number }) {
	const code = useMemo(() => {
		const qr = qrcode(0, 'M');
		qr.addData(value);
		qr.make();
		return qr;
	}, [value]);
	const count = code.getModuleCount();
	// Four modules of white quiet zone on each side, as scanners expect.
	const cell = Math.max(2, Math.floor(size / (count + 8)));
	const rows: ReactNode[] = [];
	for (let row = 0; row < count; row++) {
		const runs: ReactNode[] = [];
		for (let col = 0; col < count; ) {
			if (!code.isDark(row, col)) {
				col++;
				continue;
			}
			let end = col;
			while (end < count && code.isDark(row, end)) end++;
			runs.push(<View key={col} style={{ position: 'absolute', left: col * cell, width: (end - col) * cell, height: cell, backgroundColor: '#000' }} />);
			col = end;
		}
		rows.push(<View key={row} style={{ height: cell }}>{runs}</View>);
	}
	return (
		<View accessibilityRole="image" accessibilityLabel="QR code to scan with a phone" style={{ backgroundColor: '#fff', padding: cell * 4, borderRadius: 8 }}>
			<View style={{ width: count * cell, height: count * cell }}>{rows}</View>
		</View>
	);
}

/** The backdrop and panel of a bottom sheet; on a wide screen the panel floats centred instead. */
export function useSheetStyles() {
	const { wide } = useLayout();
	const { bottom } = useSafeAreaInsets();
	// A bottom sheet clears the gesture bar; a floating one sits inside the backdrop's padding.
	return { backdrop: [styles.modalBackdrop, wide && { justifyContent: 'center' as const, padding: 24 }], sheet: [styles.modalSheet, wide ? styles.modalSheetWide : { paddingBottom: 18 + bottom }] };
}

/** The app's one icon set; its font is embedded at build time (expo-font in app.json), so icons draw on first frame. */
export type IconName = keyof typeof MaterialCommunityIcons.glyphMap;
export function Icon({ name, size = 20, color }: { name: IconName; size?: number; color: string }) {
	return <MaterialCommunityIcons name={name} size={size} color={color} />;
}

/** A search box with a magnifier and a clear button that empties it in one tap. */
export function SearchField({ value, onChangeText, placeholder, accessibilityLabel }: { value: string; onChangeText: (text: string) => void; placeholder: string; accessibilityLabel: string }) {
	const theme = useAppTheme();
	const [focused, setFocused] = useState(false);
	const tv = useTvEditing();
	const box = (
		<View style={[styles.searchBox, { backgroundColor: theme.input, borderColor: focused ? theme.focus : theme.border }, focused && { borderWidth: 2 }]}>
			<Icon name="magnify" size={20} color={theme.muted} />
			{tv.button ? (
				<Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} {...tv.button} style={{ flex: 1, borderRadius: 6 }}>
				<TextInput
					accessibilityLabel={accessibilityLabel}
					value={value}
					onChangeText={onChangeText}
					placeholder={placeholder}
					placeholderTextColor={theme.muted}
					autoCapitalize="none"
					autoCorrect={false}
					returnKeyType="search"
					ref={tv.ref}
					{...tv.input}
					onFocus={() => setFocused(true)}
					onBlur={() => { setFocused(false); tv.ended(); }}
					// Android TV's button wrapper left the text sized by padding alone and clipped its top: a fixed line box.
				style={[{ flex: 1, paddingVertical: 8, fontSize: 15, color: theme.text }, ANDROID_TV && { height: 40, paddingVertical: 0, textAlignVertical: 'center' }]}
				/>
				</Pressable>
			) : (
				<TextInput
					accessibilityLabel={accessibilityLabel}
					value={value}
					onChangeText={onChangeText}
					placeholder={placeholder}
					placeholderTextColor={theme.muted}
					autoCapitalize="none"
					autoCorrect={false}
					returnKeyType="search"
					ref={tv.ref}
					{...tv.input}
					onFocus={() => setFocused(true)}
					onBlur={() => { setFocused(false); tv.ended(); }}
					// Android TV's button wrapper left the text sized by padding alone and clipped its top: a fixed line box.
				style={[{ flex: 1, paddingVertical: 8, fontSize: 15, color: theme.text }, ANDROID_TV && { height: 40, paddingVertical: 0, textAlignVertical: 'center' }]}
				/>
			)}
			{value ? (
				<Pressable accessibilityRole="button" accessibilityLabel="Clear search" onPress={() => onChangeText('')} hitSlop={12} style={{ padding: 2 }}>
					<Icon name="close-circle" size={20} color={theme.muted} />
				</Pressable>
			) : null}
		</View>
	);
	return box;
}

/** A round icon-only button for headers; the label is read out by screen readers. */
export function IconButton({ icon, label, onPress, color, filled = false, disabled = false }: { icon: IconName; label: string; onPress: () => void; color: string; filled?: boolean; disabled?: boolean }) {
	const theme = useAppTheme();
	return (
		<Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} disabled={disabled} hitSlop={4} style={({ pressed }) => [styles.iconButton, { backgroundColor: filled ? color : pressed ? theme.surface : 'transparent', borderColor: color, opacity: disabled ? 0.55 : 1 }]}>
			<Icon name={icon} size={22} color={filled ? theme.onAccent : color} />
		</Pressable>
	);
}

export function Screen({ children, edges = ['top', 'bottom'] }: { children: ReactNode; edges?: Edge[] }) {
	const theme = useAppTheme();
	// Apple TV's overscan insets would double under its 2× scale; half of them as padding keeps Apple's margin.
	if (TV_SCALE > 1) return <View style={[styles.screen, { backgroundColor: theme.background, paddingTop: 30, paddingBottom: 30, paddingRight: 40 }]}>{children}</View>;
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
	icon,
}: {
	label: string;
	active: boolean;
	onPress: () => void;
	/** Drawn after the label, e.g. a close mark on a filter that can be cleared. */
	icon?: IconName;
}) {
	const theme = useAppTheme();
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityState={{ selected: active }}
			style={[styles.filterButton, { flexDirection: 'row', alignItems: 'center', gap: 4, borderColor: active ? theme.accent : theme.border, backgroundColor: active ? theme.accent : theme.surface }]}
			onPress={onPress}
		>
			<Text style={[styles.filterText, { color: active ? theme.onAccent : theme.text }]}>{label}</Text>
			{icon ? <Icon name={icon} size={16} color={active ? theme.onAccent : theme.text} /> : null}
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
		// The row and its ⋮ are siblings, not nested: a TV remote moves right from one to the other.
		<View style={[styles.row, { height: ROW_HEIGHT, gap: 0, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border, backgroundColor: selected ? theme.input : theme.background }]}>
			<Pressable
				accessibilityRole={selecting ? 'checkbox' : 'button'}
				accessibilityState={selecting ? { checked: selected } : undefined}
				accessibilityLabel={selecting ? `Select ${item.title}` : `Open ${item.title}`}
				accessibilityHint={selecting ? undefined : 'Long press to select'}
				onPress={() => onPress(item)}
				onLongPress={() => onLongPress(item)}
				style={({ pressed, focused }) => [styles.row, { flex: 1, height: ROW_HEIGHT, paddingLeft: 12, backgroundColor: pressed || focused ? theme.surface : 'transparent' }]}
			>
				{selecting ? <View style={{ width: 28 }}><Icon name={selected ? 'checkbox-marked-circle' : 'checkbox-blank-circle-outline'} size={22} color={selected ? theme.accent : theme.muted} /></View> : null}
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
			</Pressable>
			<Pressable accessibilityRole="button" accessibilityLabel={`More for ${item.title}`} onPress={() => onMore(item)} style={{ width: 40, height: ROW_HEIGHT, alignItems: 'center', justifyContent: 'center' }}>
				<Icon name="dots-vertical" size={22} color={theme.muted} />
			</Pressable>
		</View>
	);
});

/** A compact dropdown chip: shows the current choice and opens a sheet of options. */
export function DropdownChip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
	const theme = useAppTheme();
	return (
		<Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={{ height: 32, paddingLeft: 12, paddingRight: 6, borderRadius: 16, borderWidth: 1, flexDirection: 'row', alignItems: 'center', gap: 2, borderColor: active ? theme.accent : theme.border, backgroundColor: active ? theme.accent : theme.surface }}>
			<Text numberOfLines={1} style={{ fontSize: 13, fontWeight: '600', color: active ? theme.onAccent : theme.text }}>{label}</Text>
			<Icon name="menu-down" size={18} color={active ? theme.onAccent : theme.muted} />
		</Pressable>
	);
}

export interface SheetAction {
	label: string;
	onPress: () => void;
	destructive?: boolean;
	/** The current choice in a picker; drawn as a check mark. */
	checked?: boolean;
}

/** A bottom sheet of actions; Android alerts hold three buttons at most. */
export function ActionSheet({ title, detail, actions, onClose }: { title: string; detail?: string; actions: SheetAction[]; onClose: () => void }) {
	const theme = useAppTheme();
	const sheetStyles = useSheetStyles();
	return (
		<Modal visible animationType="slide" transparent onRequestClose={onClose}>
			<TvScale>
			{/* Neither layer takes a remote's focus: only the actions in the sheet should. */}
			<RNPressable focusable={false} style={sheetStyles.backdrop} onPress={onClose} accessibilityLabel="Close actions">
				<RNPressable focusable={false} style={[sheetStyles.sheet, { backgroundColor: theme.surface }]} onPress={() => undefined}>
					<View style={styles.rowBetween}>
						<Text numberOfLines={3} style={[styles.modalTitle, { flex: 1, color: theme.text }]}>{title}</Text>
						<Pressable accessibilityRole="button" accessibilityLabel="Close actions" onPress={onClose} hitSlop={10}><Icon name="close" size={24} color={theme.muted} /></Pressable>
					</View>
					{detail ? <Text style={[styles.subheading, { color: theme.muted }]}>{detail}</Text> : null}
					<ScrollView style={{ maxHeight: 460 }} contentContainerStyle={{ gap: 8 }}>
						{actions.map((action) => (
							<Pressable key={action.label} accessibilityRole="button" accessibilityState={action.checked === undefined ? undefined : { selected: action.checked }} accessibilityLabel={action.label} onPress={() => { onClose(); action.onPress(); }} style={[styles.outlineButton, { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderColor: action.checked ? theme.accent : action.destructive ? theme.danger : theme.border, minHeight: 46 }]}>
								<Text style={[styles.outlineButtonText, { flex: 1, color: action.destructive ? theme.danger : action.checked ? theme.accent : theme.text, fontSize: 15 }]}>{action.label}</Text>
								{action.checked ? <Icon name="check" size={20} color={theme.accent} /> : null}
							</Pressable>
						))}
					</ScrollView>
				</RNPressable>
			</RNPressable>
		</TvScale>
		</Modal>
	);
}

/**
 * A TV signs in the way DMM's Kodi addon links: scan the QR (or open debridmediamanager.com/tv and type the
 * code) on a phone signed in to DMM, and that phone's debrid logins and settings come to this TV.
 */
export function TvLinkPanel({ onLinked, signedIn }: { onLinked: (state: BrowserState) => Promise<unknown>; signedIn: boolean }) {
	const theme = useAppTheme();
	const [pairing, setPairing] = useState<TvPairing | null>(null);
	const [error, setError] = useState('');
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		setError('');
		setPairing(null);
		const run = async () => {
			try {
				const current = await startTvPairing();
				if (cancelled) return;
				setPairing(current);
				const poll = async () => {
					if (cancelled) return;
					try {
						const result = await pollTvPairing(current.deviceCode);
						if (cancelled) return;
						// A code lives ten minutes; a TV left on this screen just gets a fresh one.
						if (result.status === 'expired') return setAttempt((n) => n + 1);
						if (result.status === 'linked') {
							await onLinked(result.state);
							if (!cancelled) setAttempt((n) => n + 1);
							return;
						}
					} catch {
						// A dropped poll is retried on the next tick.
					}
					timer = setTimeout(() => void poll(), current.interval * 1000);
				};
				timer = setTimeout(() => void poll(), current.interval * 1000);
			} catch (caught) {
				if (!cancelled) setError(caught instanceof Error ? caught.message : 'DMM could not start linking.');
			}
		};
		void run();
		return () => {
			cancelled = true;
			if (timer) clearTimeout(timer);
		};
	}, [attempt, onLinked]);
	const page = pairing ? pairing.verifyUrl.replace(/^https?:\/\//, '').replace(/\?.*$/, '') : 'debridmediamanager.com/tv';
	return (
		<View style={[styles.accountCard, { backgroundColor: theme.surface, borderColor: theme.border, flexDirection: 'row', alignItems: 'center', gap: 24 }]}>
			{pairing ? <QrCode value={pairing.verifyUrl} size={180} /> : <View style={{ width: 180, height: 180, alignItems: 'center', justifyContent: 'center' }}>{error ? <Icon name="qrcode-remove" size={64} color={theme.muted} /> : <ActivityIndicator color={theme.accent} />}</View>}
			<View style={{ flex: 1, gap: 8 }}>
				<Text style={[styles.accountTitle, { color: theme.text }]}>{signedIn ? 'Add logins from your phone' : 'Sign in with your phone'}</Text>
				<Text style={[styles.subheading, { color: theme.muted, marginTop: 0 }]}>Scan the code with a phone signed in to DMM, or open {page} on any device and enter:</Text>
				<Text selectable accessibilityLabel={pairing ? `Code ${pairing.userCode}` : 'Getting a code'} style={[styles.deviceCode, { color: theme.text }]}>{pairing?.userCode ?? '····-····'}</Text>
				<Text style={[styles.subheading, { color: theme.muted, marginTop: 0 }]}>The debrid logins and settings DMM has on that phone come to this TV.</Text>
				{error ? (
					<View style={styles.row}>
						<Text style={[styles.inlineError, { color: theme.danger, flex: 1 }]}>{error}</Text>
						<Pressable accessibilityRole="button" accessibilityLabel="Get a new code" onPress={() => setAttempt((n) => n + 1)} style={[styles.outlineButton, { borderColor: theme.accent }]}><Text style={[styles.outlineButtonText, { color: theme.accent }]}>Try again</Text></Pressable>
					</View>
				) : null}
			</View>
		</View>
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
					<TextField
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
	searchBox: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderRadius: 10, paddingLeft: 10, paddingRight: 10 },
	iconButton: { width: 38, height: 38, borderRadius: 19, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
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
	detailSection: { marginTop: 16 },
	detailTitle: { fontSize: 23, fontWeight: '700', marginTop: 12 },
	detailMeta: { fontSize: 14, marginTop: 6 },
	fileRow: { paddingVertical: 12, borderBottomWidth: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
	fileName: { flex: 1, fontSize: 15 },
	fileSize: { fontSize: 12, flexShrink: 0, textAlign: 'right' },
	fileButton: { minHeight: 36, borderRadius: 8, paddingHorizontal: 10, justifyContent: 'center' },
	fileButtonText: { fontSize: 13, fontWeight: '700' },
	modalBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.45)' },
	modalSheet: { borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 18, gap: 12, flexGrow: 0 },
	modalSheetWide: { alignSelf: 'center', width: '100%', maxWidth: 560, borderRadius: 22 },
	contentWide: { alignSelf: 'center', width: '100%', maxWidth: 840 },
	modalTitle: { fontSize: 21, fontWeight: '700' },
	modalButtonRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
});
