import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Platform, Pressable as PlainPressable, StyleSheet, Text, useTVEventHandler, View, type GestureResponderEvent } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import VLCPlayer, { type VLCPlayerRef, type VLCPlayerTracks } from '@lunarr/vlc-player';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useApp } from '../AppContext';
import { filePath, isVideoName } from '../core';
import type { RootStackParamList } from '../navigation';
import { FINISHED, playback, playbackKey } from '../playback';
import { BUILT_IN, openFileLink, playersForPlatform, soundUnplayable } from '../player';
import { findEpisode, nextEpisode, showEpisodes, type EpisodeCopy } from '../titles';
import { isSafeExternalUrl } from '../validation';
import { ActionSheet, Icon, Pressable, type IconName, type SheetAction } from '../ui';

type Props = NativeStackScreenProps<RootStackParamList, 'Player'>;

const SKIP_MS = 10_000;
const SAVE_EVERY_MS = 5_000;
const HIDE_AFTER_MS = 4_000;
const NEXT_IN_S = 10;
/** A dropped connection leaves libVLC playing a frozen picture with no error: this long without the clock moving is a stop. */
const STALL_MS = 30_000;
const SUBTITLE = /\.(srt|ass|ssa|vtt|sub)$/i;
const ACCENT = '#8ab4ff';

const baseName = (name: string) => name.split('/').pop() ?? name;
const stem = (name: string) => baseName(name).replace(/\.[^.]+$/, '');
const pad = (n: number) => String(n).padStart(2, '0');
export const clock = (ms: number): string => {
	const total = Math.max(0, Math.floor(ms / 1000));
	const [h, m, s] = [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60];
	return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
};
const episodeLabel = (copy: EpisodeCopy) => (copy.ref ? `S${pad(copy.ref.season)}E${pad(copy.ref.episode)}${copy.ref.end ? `-E${pad(copy.ref.end)}` : ''}` : baseName(copy.file.name));
/** VLC names tracks after their language and title, which repeat; the sheet needs each label once. */
const uniqueLabels = (names: string[]) => names.map((name, n) => (names.indexOf(name) === n ? name : `${name} (${names.slice(0, n + 1).filter((other) => other === name).length})`));

/**
 * The built-in player (libVLC 3): any container and codec the provider serves, embedded audio and
 * subtitle tracks, subtitle files from the same release, resume, and the show's next episode.
 * libVLC 4 (expo-libvlc-player 58.0.9) was tried first: it read a Real-Debrid MKV from the start
 * up to every seek target (4 GB for one seek on the Pixel 6), where libVLC 3 jumps there.
 */
export function PlayerScreen({ route, navigation }: Props) {
	const { url, item, fileId } = route.params;
	const { titles, snapshot, openFile } = useApp();
	const file = item.files.find((entry) => entry.id === fileId) ?? { id: fileId, name: 'Video', size: 0 };
	const key = playbackKey(item, file);
	const named = titles.identification(item);

	// A show's episodes, to name this one and find the next. Files read for the title page are remembered.
	const [counts, setCounts] = useState<Record<string, number>>();
	useEffect(() => {
		if (named?.kind === 'tv') void titles.info(named.imdbId, 'tv').then((info) => setCounts(info.season_episode_counts)).catch(() => undefined);
	}, [named?.imdbId, named?.kind, titles]);
	const { current, next } = useMemo(() => {
		if (named?.kind !== 'tv') return { current: undefined, next: null };
		const copies = snapshot.items
			.filter((entry) => titles.identification(entry)?.imdbId === named.imdbId)
			.map((entry) => {
				const files = entry.id === item.id ? item.files : titles.filesOf(entry) ?? [];
				return { item: { ...entry, files }, files, seasons: titles.identification(entry)?.seasons };
			});
		const episodes = showEpisodes(copies, counts);
		const found = findEpisode(episodes, item.id, fileId);
		return { current: found, next: found ? nextEpisode(episodes, found) : null };
	}, [counts, fileId, item, named?.imdbId, named?.kind, snapshot.items, titles]);
	const title = named ? (current ? `${named.title} · ${episodeLabel(current)}` : named.title) : baseName(file.name);
	const meta = useMemo(() => ({ name: baseName(file.name), imdbId: named?.imdbId, season: current?.ref?.season, episode: current?.ref?.episode }), [current, file.name, named?.imdbId]);

	// Subtitle files beside the video: all of a one-video release's, else those named after it.
	const externalSubs = useMemo(() => {
		const single = item.files.filter((entry) => isVideoName(entry.name)).length <= 1;
		return item.files.filter((entry) => SUBTITLE.test(entry.name) && entry.selected !== false && (single || stem(entry.name).startsWith(stem(file.name))));
	}, [file.name, item.files]);

	const player = useRef<VLCPlayerRef>(null);
	const mounted = useRef(true);
	const position = useRef({ time: 0, duration: 0, savedAt: 0, movedAt: 0 });
	/** Whether the sound was checked once the video started: 'asked' while libVLC lists its tracks. */
	const soundCheck = useRef<'no' | 'asked' | 'done'>('no');
	/** Where playback starts; null while asking whether to resume. */
	const [start, setStart] = useState<number | null>(null);
	const [resumeAt, setResumeAt] = useState(0);
	const [attempt, setAttempt] = useState(0);
	const [time, setTime] = useState(0);
	const [duration, setDuration] = useState(0);
	const [paused, setPaused] = useState(false);
	const [buffering, setBuffering] = useState(true);
	const [error, setError] = useState('');
	const [tracks, setTracks] = useState<VLCPlayerTracks | null>(null);
	const [controls, setControls] = useState<'shown' | 'peek' | 'hidden'>('shown');
	const [poked, setPoked] = useState(0);
	const [sheet, setSheet] = useState<'audio' | 'subtitle' | 'apps' | null>(null);
	const [countdown, setCountdown] = useState<number | null>(null);
	const [scrub, setScrub] = useState<number | null>(null);
	// The release handler runs before a re-render when a touch is a tap, so it reads the ref.
	const scrubbing = useRef<number | null>(null);
	const barWidth = useRef(1);

	useEffect(() => {
		mounted.current = true;
		void playback.load().then(() => {
			if (!mounted.current) return;
			const at = playback.resumeAt(key);
			if (at) setResumeAt(at);
			else setStart(0);
		});
		return () => void (mounted.current = false);
	}, [key]);

	// The screen stays on while a video plays, not while one sits paused.
	useEffect(() => {
		if (paused || start === null) return undefined;
		void activateKeepAwakeAsync('player').catch(() => undefined);
		return () => void deactivateKeepAwake('player').catch(() => undefined);
	}, [paused, start]);

	const save = useCallback(() => {
		const { time: at, duration: length } = position.current;
		if (at > 0 && length > 0) void playback.record(key, at, length, meta);
	}, [key, meta]);
	// On leaving the player, and when the app goes to the background (the player pauses itself).
	useEffect(() => {
		const subscription = AppState.addEventListener('change', (state) => state !== 'active' && save());
		return () => {
			subscription.remove();
			save();
		};
	}, [save]);

	const show = useCallback((mode: 'shown' | 'peek' = 'shown') => {
		setControls((was) => (was === 'shown' ? 'shown' : mode));
		setPoked((n) => n + 1);
	}, []);
	useEffect(() => {
		// They stay while the file opens or buffers, so the first thing seen is not a blank screen.
		if (controls === 'hidden' || paused || buffering || sheet || error || start === null) return undefined;
		const timer = setTimeout(() => setControls('hidden'), controls === 'peek' ? 1500 : HIDE_AFTER_MS);
		return () => clearTimeout(timer);
	}, [buffering, controls, error, paused, poked, sheet, start]);

	const seekTo = useCallback((ms: number) => {
		const target = Math.round(Math.max(0, position.current.duration ? Math.min(ms, position.current.duration - 1000) : ms));
		position.current.time = target;
		setTime(target);
		player.current?.seek(target / 1000);
	}, []);
	const skip = useCallback((ms: number) => seekTo(position.current.time + ms), [seekTo]);
	useEffect(() => {
		if (paused || error || countdown !== null || start === null) return undefined;
		// Counted once the clock has moved: opening a file (libVLC's first font scan on a Fire TV took 26 s) is not a stall.
		if (position.current.movedAt) position.current.movedAt = Date.now();
		const timer = setInterval(() => {
			if (!position.current.movedAt || Date.now() - position.current.movedAt < STALL_MS) return;
			save();
			setError(`Playback stopped at ${clock(position.current.time)}: the stream stopped arriving.`);
		}, 5000);
		return () => clearInterval(timer);
	}, [countdown, error, paused, save, start]);
	const toggle = useCallback(() => (paused ? player.current?.play() : player.current?.pause()), [paused]);

	const controlsShown = useRef(controls);
	controlsShown.current = controls;
	useTVEventHandler(
		useCallback(
			(event) => {
				// Keys arrive pressed (0) and released (1); act once.
				if (!Platform.isTV || Number(event.eventKeyAction) === 0 || countdown !== null) return;
				const hidden = controlsShown.current !== 'shown';
				switch (event.eventType) {
					case 'playPause':
						toggle();
						return show();
					case 'play':
						return player.current?.play();
					case 'pause':
						return player.current?.pause();
					case 'fastForward':
					case 'rewind':
						skip(event.eventType === 'rewind' ? -SKIP_MS : SKIP_MS);
						return show('peek');
					case 'left':
					case 'right':
						// While the buttons are up, left and right move between them.
						if (!hidden) return;
						skip(event.eventType === 'left' ? -SKIP_MS : SKIP_MS);
						return show('peek');
					case 'up':
					case 'down':
						if (hidden) show();
				}
			},
			[countdown, show, skip, toggle]
		)
	);

	const playNext = useCallback(
		async (copy: EpisodeCopy) => {
			try {
				const link = await openFile(copy.item.provider, copy.item, copy.file.id);
				if (!isSafeExternalUrl(link)) throw new Error('The provider returned an unsafe file URL.');
				if (mounted.current) navigation.replace('Player', { url: link, item: copy.item, fileId: copy.file.id });
			} catch (caught) {
				if (mounted.current) {
					setCountdown(null);
					setError(caught instanceof Error ? caught.message : 'Could not open the next episode.');
				}
			}
		},
		[navigation, openFile]
	);
	useEffect(() => {
		if (countdown === null || !next) return undefined;
		if (countdown === 0) return void playNext(next);
		const timer = setTimeout(() => setCountdown((n) => (n === null ? n : n - 1)), 1000);
		return () => clearTimeout(timer);
	}, [countdown, next, playNext]);

	const ended = () => {
		if (error || !mounted.current) return;
		const { time: at, duration: length } = position.current;
		if (length > 0 && at < length * FINISHED) {
			// A link that drops mid-file ends the stream early: offer to pick up where it stopped.
			save();
			return setError(`Playback stopped at ${clock(at)}.`);
		}
		position.current.time = length;
		save();
		if (next) setCountdown(NEXT_IN_S);
		else navigation.goBack();
	};

	const addSubtitleFile = async (id: string) => {
		try {
			const link = await openFile(item.provider, item, id);
			if (!isSafeExternalUrl(link)) throw new Error('The provider returned an unsafe file URL.');
			player.current?.setSubtitleFile(link);
		} catch (caught) {
			if (mounted.current) setError(caught instanceof Error ? caught.message : 'Could not open the subtitle file.');
		}
	};
	const trackActions = (type: 'audio' | 'subtitle'): SheetAction[] => {
		const list = tracks?.[type] ?? [];
		const current = type === 'audio' ? tracks?.audioIndex : tracks?.subtitleIndex;
		const labels = uniqueLabels(list.map((track) => (track.id === -1 ? (type === 'audio' ? 'No sound' : 'Off') : track.name || `Track ${track.id}`)));
		const embedded = list.map((track, n) => ({
			label: labels[n],
			checked: current === track.id,
			onPress: () => {
				if (type === 'audio') player.current?.selectAudioTrack(track.id);
				else player.current?.selectSubtitleTrack(track.id);
				setTracks((was) => (was ? { ...was, [type === 'audio' ? 'audioIndex' : 'subtitleIndex']: track.id } : was));
			},
		}));
		if (type === 'audio') return embedded;
		// The files' own names stay apart from VLC's track names, which never end in an extension.
		const files = externalSubs.map((entry) => ({ label: `${baseName(entry.name)}`, onPress: () => void addSubtitleFile(entry.id) }));
		return [...embedded, ...files];
	};
	// Asked afresh each time: libVLC picks tracks itself (a default subtitle) and adds subtitle files later.
	const openSheet = (type: 'audio' | 'subtitle') => {
		player.current?.getTracks();
		setSheet(type);
	};
	const otherApps: SheetAction[] = playersForPlatform()
		.filter((option) => option.id !== BUILT_IN)
		.map((option) => ({
			label: option.label,
			onPress: () => void openFileLink(url, baseName(file.name), option.id).catch((caught) => setError(caught instanceof Error ? caught.message : 'Could not open another app.')),
		}));

	const scrubTo = (event: GestureResponderEvent) => {
		scrubbing.current = Math.min(1, Math.max(0, event.nativeEvent.locationX / barWidth.current)) * duration;
		setScrub(scrubbing.current);
		show();
	};
	const shownTime = scrub ?? time;
	const progress = duration ? Math.min(100, (shownTime / duration) * 100) : 0;

	const button = (icon: IconName, label: string, onPress: () => void, size = 30, preferred = false) => (
		<Pressable accessibilityRole="button" accessibilityLabel={label} hasTVPreferredFocus={Platform.isTV && preferred} onPress={() => { onPress(); show(); }} style={({ focused }) => [local.button, focused && local.focused]}>
			<Icon name={icon} size={size} color="#fff" />
		</Pressable>
	);
	const textButton = (label: string, onPress: () => void, preferred = false) => (
		<Pressable accessibilityRole="button" accessibilityLabel={label} hasTVPreferredFocus={Platform.isTV && preferred} onPress={onPress} style={({ focused }) => [local.textButton, focused && local.focused]}>
			<Text style={local.textButtonLabel}>{label}</Text>
		</Pressable>
	);

	return (
		<View style={local.screen}>
			{start !== null ? (
				<VLCPlayer
					key={attempt}
					ref={player}
					style={StyleSheet.absoluteFill}
					// Opened at the resume point rather than started and then moved there.
					source={{ uri: url, isNetwork: true, mediaOptions: start ? [`:start-time=${start / 1000}`] : [] }}
					continueAudioInBackground={false}
					showNowPlaying={false}
					progressUpdateInterval={500}
					onProgress={({ currentTime, duration: length }) => {
						if (currentTime * 1000 !== position.current.time) position.current.movedAt = Date.now();
						position.current.time = currentTime * 1000;
						if (length > 0 && length * 1000 !== position.current.duration) {
							position.current.duration = length * 1000;
							setDuration(length * 1000);
						}
						// Whole seconds: the clock shows no more.
						if (scrubbing.current === null) setTime(Math.floor(currentTime) * 1000);
						const now = Date.now();
						if (now - position.current.savedAt >= SAVE_EVERY_MS) {
							position.current.savedAt = now;
							save();
						}
					}}
					onBuffer={({ isBuffering }) => setBuffering(Boolean(isBuffering))}
					onPlaying={() => {
						setPaused(false);
						setBuffering(false);
						if (soundCheck.current === 'no') {
							soundCheck.current = 'asked';
							player.current?.getTracks();
						}
					}}
					onPaused={() => setPaused(true)}
					onEnd={ended}
					onTracks={(listed) => {
						setTracks(listed);
						if (soundCheck.current !== 'asked') return;
						soundCheck.current = 'done';
						// Rather than play on in silence.
						if (soundUnplayable(listed)) {
							player.current?.pause();
							save();
							setError('Its sound is in a format this player cannot decode.');
						}
					}}
					onError={() => setError('This file could not be played here.')}
				/>
			) : null}

			{/* The whole screen shows the controls: a tap on a phone, Select on a remote. No focus outline around the picture. */}
			<PlainPressable
				accessibilityRole="button"
				accessibilityLabel={controls === 'shown' ? 'Hide controls' : 'Show controls'}
				focusable={Platform.isTV && controls !== 'shown' && !error && countdown === null && start !== null}
				hasTVPreferredFocus={Platform.isTV && controls !== 'shown'}
				onPress={() => (controls === 'shown' ? setControls('hidden') : show())}
				style={StyleSheet.absoluteFill}
			/>

			{buffering && !error && start !== null ? <ActivityIndicator size="large" color="#fff" style={local.center} pointerEvents="none" /> : null}

			{controls !== 'hidden' && start !== null && !error && countdown === null ? (
				<View style={local.overlay} pointerEvents="box-none">
					{controls === 'shown' ? (
						<View style={local.top}>
							{Platform.isTV ? null : button('arrow-left', 'Back', () => navigation.goBack(), 26)}
							<Text numberOfLines={1} style={local.title}>{title}</Text>
						</View>
					) : <View />}
					{controls === 'shown' ? (
						<View style={local.middle} pointerEvents="box-none">
							{button('rewind-10', 'Back 10 seconds', () => skip(-SKIP_MS), 36)}
							{button(paused ? 'play' : 'pause', paused ? 'Play' : 'Pause', toggle, 52, true)}
							{button('fast-forward-10', 'Forward 10 seconds', () => skip(SKIP_MS), 36)}
						</View>
					) : null}
					<View style={local.bottom}>
						<View style={local.timeRow}>
							<Text style={local.time}>{clock(shownTime)}</Text>
							<View
								style={local.bar}
								onLayout={(event) => (barWidth.current = event.nativeEvent.layout.width || 1)}
								onStartShouldSetResponder={() => !Platform.isTV && duration > 0}
								onResponderGrant={scrubTo}
								onResponderMove={scrubTo}
								onResponderRelease={() => {
									if (scrubbing.current !== null) seekTo(scrubbing.current);
									scrubbing.current = null;
									setScrub(null);
								}}
								onResponderTerminate={() => {
									scrubbing.current = null;
									setScrub(null);
								}}
							>
								<View style={local.track} pointerEvents="none">
									<View style={[local.fill, { width: `${progress}%` }]} />
								</View>
								<View style={[local.knob, { left: `${progress}%` }]} pointerEvents="none" />
							</View>
							<Text style={local.time}>{duration ? clock(duration) : '--:--'}</Text>
						</View>
						{controls === 'shown' ? (
							// Centred on a TV, under the play button: Android's focus search does not reach a corner row from it.
							<View style={[local.actions, Platform.isTV && { justifyContent: 'center' }]}>
								{button('volume-high', 'Audio track', () => openSheet('audio'), 26)}
								{button('subtitles-outline', 'Subtitles', () => openSheet('subtitle'), 26)}
								{next ? button('skip-next', `Next episode, ${episodeLabel(next)}`, () => void playNext(next), 26) : null}
							</View>
						) : null}
					</View>
				</View>
			) : null}

			{start === null && resumeAt > 0 ? (
				<View style={local.dialog}>
					<Text style={local.dialogTitle} numberOfLines={2}>{title}</Text>
					{textButton(`Resume from ${clock(resumeAt)}`, () => setStart(resumeAt), true)}
					{textButton('Start over', () => setStart(0))}
				</View>
			) : null}

			{countdown !== null && next ? (
				<View style={local.dialog}>
					<Text style={local.dialogTitle}>Next episode: {episodeLabel(next)}</Text>
					<Text style={local.dialogText}>Starts in {countdown} s</Text>
					{textButton('Play now', () => setCountdown(0), true)}
					{textButton('Cancel', () => navigation.goBack())}
				</View>
			) : null}

			{error ? (
				<View style={local.dialog}>
					<Text style={local.dialogTitle}>Could not play {baseName(file.name)}</Text>
					<Text style={local.dialogText}>{error}</Text>
					{textButton('Try again', () => {
						setError('');
						soundCheck.current = 'no';
						setBuffering(true);
						setStart(position.current.time);
						setAttempt((n) => n + 1);
					}, true)}
					{otherApps.length ? textButton('Open in another app', () => setSheet('apps')) : null}
					{textButton('Back', () => navigation.goBack())}
				</View>
			) : null}

			{sheet ? (
				<ActionSheet
					landscape
					title={sheet === 'audio' ? 'Audio' : sheet === 'subtitle' ? 'Subtitles' : 'Open in another app'}
					detail={sheet === 'subtitle' && externalSubs.length ? 'Files of this release are listed after the tracks inside the video.' : undefined}
					actions={sheet === 'apps' ? otherApps : trackActions(sheet)}
					onClose={() => setSheet(null)}
				/>
			) : null}
		</View>
	);
}

const local = StyleSheet.create({
	screen: { flex: 1, backgroundColor: '#000' },
	center: { position: 'absolute', alignSelf: 'center', top: '45%' },
	overlay: { ...StyleSheet.absoluteFill, justifyContent: 'space-between', backgroundColor: 'rgba(0,0,0,0.35)' },
	top: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 24, paddingTop: 16 },
	title: { flex: 1, color: '#fff', fontSize: 17, fontWeight: '700' },
	middle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 36 },
	bottom: { paddingHorizontal: 24, paddingBottom: 16 },
	timeRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
	time: { color: '#fff', fontSize: 13, fontVariant: ['tabular-nums'], minWidth: 52, textAlign: 'center' },
	bar: { flex: 1, height: 32, justifyContent: 'center' },
	track: { height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.35)', overflow: 'hidden' },
	fill: { height: 4, backgroundColor: ACCENT },
	knob: { position: 'absolute', width: 14, height: 14, borderRadius: 7, marginLeft: -7, backgroundColor: ACCENT },
	actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
	button: { padding: 8, borderRadius: 40, alignItems: 'center', justifyContent: 'center' },
	focused: { backgroundColor: 'rgba(255,255,255,0.25)' },
	dialog: { position: 'absolute', alignSelf: 'center', top: '20%', width: 340, maxWidth: '90%', padding: 18, gap: 10, borderRadius: 14, backgroundColor: 'rgba(21,29,49,0.95)' },
	dialogTitle: { color: '#fff', fontSize: 17, fontWeight: '700' },
	dialogText: { color: '#a6b2c8', fontSize: 14 },
	textButton: { minHeight: 44, borderRadius: 10, paddingHorizontal: 14, justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.3)' },
	textButtonLabel: { color: '#fff', fontSize: 15, fontWeight: '700' },
});
