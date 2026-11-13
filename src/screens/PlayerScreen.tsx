import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Animated, AppState, Image, Modal, Platform, Pressable as PlainPressable, ScrollView, StyleSheet, Text, useTVEventHandler, useWindowDimensions, View, type GestureResponderEvent } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import VLCPlayer, { type VLCPlayerRef, type VLCPlayerTracks } from '@lunarr/vlc-player';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useApp } from '../AppContext';
import { otherCopies, readEpisodeTitles } from '../calendar';
import { formatBytes, isVideoName } from '../core';
import { copyFacts, filmProbe, playerBadges, probeFor } from '../mediaInfo';
import { PROVIDER_META, type LibraryFile, type LibraryItem } from '../model';
import type { RootStackParamList } from '../navigation';
import { FINISHED, playback, playbackKey } from '../playback';
import { BUILT_IN, endsAt, FITS, openFileLink, playersForPlatform, ratioBox, SLEEP_MINUTES, sleepLabel, soundUnplayable, SPEEDS, type Fit, type Sleep } from '../player';
import { episodeCode, findEpisode, logoUrl, mainFile, nextEpisode, pickCopy, qualityOf, showEpisodes, type EpisodeCopy } from '../titles';
import { refOf, type ScrobbleAction } from '../trackerSync';
import { otherDevice } from '../watched';
import { isSafeExternalUrl } from '../validation';
import { ActionSheet, Icon, Pressable, TvScale, type IconName, type SheetAction } from '../ui';

type Props = NativeStackScreenProps<RootStackParamList, 'Player'>;

const SKIP_MS = 10_000;
const SAVE_EVERY_MS = 5_000;
const HIDE_AFTER_MS = 4_000;
const NEXT_IN_S = 10;
/** A dropped connection leaves libVLC playing a frozen picture with no error: this long without the clock moving is a stop. */
const STALL_MS = 30_000;
const SUBTITLE = /\.(srt|ass|ssa|vtt|sub)$/i;
const ACCENT = '#8ab4ff';
/** Audio and subtitle delay steps, as VLC's own keys move them. */
const DELAY_STEP_MS = 50;

const baseName = (name: string) => name.split('/').pop() ?? name;
const stem = (name: string) => baseName(name).replace(/\.[^.]+$/, '');
const pad = (n: number) => String(n).padStart(2, '0');
export const clock = (ms: number): string => {
	const total = Math.max(0, Math.floor(ms / 1000));
	const [h, m, s] = [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60];
	return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
};
const episodeLabel = (copy: EpisodeCopy) => (copy.ref ? episodeCode(copy.ref.season, copy.ref.episode, copy.ref.end) : baseName(copy.file.name));
/** VLC names tracks after their language and title, which repeat; the sheet needs each label once. */
const uniqueLabels = (names: string[]) => names.map((name, n) => (names.indexOf(name) === n ? name : `${name} (${names.slice(0, n + 1).filter((other) => other === name).length})`));
const uniqueLabelsOf = (actions: SheetAction[]): SheetAction[] => {
	const labels = uniqueLabels(actions.map((action) => action.label));
	return actions.map((action, n) => ({ ...action, label: labels[n] }));
};

/**
 * The built-in player (libVLC 3): any container and codec the provider serves, embedded audio and
 * subtitle tracks, subtitle files from the same release, resume, and the show's next episode.
 * libVLC 4 (expo-libvlc-player 58.0.9) was tried first: it read a Real-Debrid MKV from the start
 * up to every seek target (4 GB for one seek on the Pixel 6), where libVLC 3 jumps there.
 */
export function PlayerScreen({ route, navigation }: Props) {
	const { url, item, fileId, resume, at: from, sleep: sleepAt } = route.params;
	const { titles, snapshot, openFile, trackers, detail } = useApp();
	// Probes and file lists that arrive while it plays.
	useSyncExternalStore(titles.subscribe, titles.getVersion);
	const file = item.files.find((entry) => entry.id === fileId) ?? { id: fileId, name: 'Video', size: 0 };
	const key = playbackKey(item, file);
	const named = titles.identification(item);

	// A show's episodes, to name this one and find the next. Files read for the title page are remembered.
	const [counts, setCounts] = useState<Record<string, number>>();
	useEffect(() => {
		if (named?.kind === 'tv') void titles.info(named.imdbId, 'tv').then((info) => setCounts(info.season_episode_counts)).catch(() => undefined);
	}, [named?.imdbId, named?.kind, titles]);
	const { episodes, current, next } = useMemo(() => {
		if (named?.kind !== 'tv') return { episodes: null, current: undefined, next: null };
		const copies = snapshot.items
			.filter((entry) => titles.identification(entry)?.imdbId === named.imdbId)
			.map((entry) => {
				const files = entry.id === item.id ? item.files : titles.filesOf(entry) ?? [];
				return { item: { ...entry, files }, files, seasons: titles.identification(entry)?.seasons };
			});
		const episodes = showEpisodes(copies, counts);
		const found = findEpisode(episodes, item.id, fileId);
		return { episodes, current: found, next: found ? nextEpisode(episodes, found) : null };
	}, [counts, fileId, item, named?.imdbId, named?.kind, snapshot.items, titles]);
	// The other copies of what plays: the same episode in any release, or the same film's other releases.
	const versions = useMemo(
		() =>
			episodes && current
				? otherCopies(episodes, current).map((copy) => ({ item: copy.item, file: copy.file, size: copy.file.size, quality: copy.quality }))
				: named?.kind === 'movie'
					? snapshot.items.filter((entry) => entry.id !== item.id && titles.identification(entry)?.imdbId === named.imdbId).map((entry) => ({ item: entry, file: undefined, size: entry.size, quality: qualityOf(entry.filename) }))
					: [],
		[current, episodes, item.id, named?.imdbId, named?.kind, snapshot.items, titles]
	);
	const title = named ? (current ? `${named.title} · ${episodeLabel(current)}` : named.title) : baseName(file.name);
	const meta = useMemo(() => ({ name: baseName(file.name), imdbId: named?.imdbId, kind: named?.kind, season: current?.ref?.season, episode: current?.ref?.episode, end: current?.ref?.end }), [current, file.name, named?.imdbId, named?.kind]);

	// Subtitle files beside the video: all of a one-video release's, else those named after it.
	const externalSubs = useMemo(() => {
		const single = item.files.filter((entry) => isVideoName(entry.name)).length <= 1;
		return item.files.filter((entry) => SUBTITLE.test(entry.name) && entry.selected !== false && (single || stem(entry.name).startsWith(stem(file.name))));
	}, [file.name, item.files]);

	// What the controls show of it: the title's logo (else its name), the episode's title, the copy's badges.
	const [episodeNames, setEpisodeNames] = useState<Map<string, string>>();
	useEffect(() => {
		if (named?.kind === 'tv') void readEpisodeTitles(named.imdbId).then((names) => mounted.current && setEpisodeNames(names)).catch(() => undefined);
	}, [named?.imdbId, named?.kind]);
	/** The logo's width over height; null for none (a 404), undefined while asked. */
	const [logo, setLogo] = useState<number | null>();
	useEffect(() => {
		if (!named) return setLogo(null);
		Image.getSize(logoUrl(named.imdbId), (width, height) => mounted.current && setLogo(width / height || null), () => mounted.current && setLogo(null));
	}, [named?.imdbId]);
	useEffect(() => void titles.loadProbes([item]), [item, titles]);

	const player = useRef<VLCPlayerRef>(null);
	const mounted = useRef(true);
	const position = useRef({ time: 0, duration: 0, savedAt: 0, movedAt: 0 });
	/** Whether the sound was checked once the video started: 'asked' while libVLC lists its tracks. */
	const soundCheck = useRef<'no' | 'asked' | 'done'>('no');
	/** Where playback starts; null while asking whether to resume. */
	const [start, setStart] = useState<number | null>(null);
	/** The resume offer: milliseconds, or a fraction of a file not played on this device yet (a tracker's progress from another device). */
	const [resumeAt, setResumeAt] = useState<{ ms: number } | { fraction: number } | null>(null);
	/** Where to jump once the duration is known, for a fraction. */
	const jumpTo = useRef<number | null>(null);
	/** What the trackers were told last: a stop is final, a start is repeated only after a seek. */
	const scrobbled = useRef<ScrobbleAction | null>(null);
	const seekTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [attempt, setAttempt] = useState(0);
	const [time, setTime] = useState(0);
	const [duration, setDuration] = useState(0);
	const [paused, setPaused] = useState(false);
	const [buffering, setBuffering] = useState(true);
	const [error, setError] = useState('');
	const [tracks, setTracks] = useState<VLCPlayerTracks | null>(null);
	const [controls, setControls] = useState<'shown' | 'peek' | 'hidden'>('shown');
	const [poked, setPoked] = useState(0);
	const [sheet, setSheet] = useState<'audio' | 'subtitle' | 'apps' | 'speed' | 'fit' | 'sleep' | 'delay' | 'episodes' | 'versions' | null>(null);
	const [locked, setLocked] = useState(false);
	const [portrait, setPortrait] = useState(false);
	const [rate, setRate] = useState(1);
	const [fit, setFit] = useState<Fit>('contain');
	const [sleep, setSleep] = useState<Sleep>(sleepAt ?? null);
	/** Milliseconds; plus plays it later. */
	const [delays, setDelays] = useState({ audio: 0, subtitle: 0 });
	/** A phone's toolbar shows its first buttons, or the rest. */
	const [page, setPage] = useState(0);
	const slide = useRef(new Animated.Value(0)).current;
	const [area, setArea] = useState({ width: 0, height: 0 });
	const windowSize = useWindowDimensions();
	const phone = !Platform.isTV && Math.min(windowSize.width, windowSize.height) < 600;
	const seekFocused = useRef(false);
	// Clear of a landscape iPhone's Dynamic Island and a phone's camera cutout.
	const insets = useSafeAreaInsets();
	const safe = { paddingLeft: insets.left, paddingRight: insets.right, paddingTop: insets.top, paddingBottom: insets.bottom };
	const [countdown, setCountdown] = useState<number | null>(null);
	const [scrub, setScrub] = useState<number | null>(null);
	// The release handler runs before a re-render when a touch is a tap, so it reads the ref.
	const scrubbing = useRef<number | null>(null);
	const barWidth = useRef(1);

	useEffect(() => {
		mounted.current = true;
		void playback.load().then(() => {
			if (!mounted.current) return;
			// Another version of what played picks up where it was.
			if (from) return begin({ ms: from });
			// Another device's newer pause (through Trakt or Simkl) wins over this device's own resume point.
			const ref = refOf(meta);
			const local = playback.get(key);
			const remote = ref ? trackers.map((tracker) => tracker.resumeFor(ref)).reduce((a, b) => (b && (!a || b.pausedAt > a.pausedAt) ? b : a), undefined) : undefined;
			const fraction = remote && otherDevice(remote, local) ? remote.progress / 100 : 0;
			const at = fraction && local?.duration ? Math.round(fraction * local.duration) : fraction ? 0 : playback.resumeAt(key);
			const offer = at ? { ms: at } : fraction ? { fraction } : null;
			// Continue Watching resumes without asking.
			if (offer && !resume) setResumeAt(offer);
			else begin(offer);
		});
		return () => void (mounted.current = false);
		// Decided once, as the player opens.
	}, [from, key, resume]);
	const begin = (offer: { ms: number } | { fraction: number } | null) => {
		if (offer && 'fraction' in offer) jumpTo.current = offer.fraction;
		setStart(offer && 'ms' in offer ? offer.ms : 0);
	};

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
	/** Tells the connected trackers what playback does; past FINISHED the first stop marks it watched there. */
	const scrobble = useCallback(
		(action: ScrobbleAction, again = false) => {
			const { time: at, duration: length } = position.current;
			if (!length || scrobbled.current === 'stop' || (scrobbled.current === action && !again)) return;
			scrobbled.current = action;
			for (const tracker of trackers) tracker.scrobble({ ...meta, provider: item.provider }, action, (at / length) * 100, again);
		},
		[item.provider, meta, trackers]
	);
	// On leaving the player, and when the app goes to the background (the player pauses itself). Through a ref:
	// the episode's name can arrive after opening, and a re-run would tell the trackers it stopped.
	const leave = useRef({ save, scrobble });
	leave.current = { save, scrobble };
	useEffect(() => {
		const subscription = AppState.addEventListener('change', (state) => {
			if (state === 'active') return;
			leave.current.save();
			leave.current.scrobble('pause');
		});
		return () => {
			subscription.remove();
			leave.current.save();
			leave.current.scrobble('stop');
		};
	}, []);
	useEffect(() => () => void (seekTimer.current && clearTimeout(seekTimer.current)), []);

	const show = useCallback((mode: 'shown' | 'peek' = 'shown') => {
		setControls((was) => (was === 'shown' ? 'shown' : mode));
		setPoked((n) => n + 1);
	}, []);
	// The seek bar leaves with the controls without a blur.
	useEffect(() => void (controls !== 'shown' && (seekFocused.current = false)), [controls]);
	useEffect(() => {
		// They stay while the file opens or buffers, so the first thing seen is not a blank screen.
		if (controls === 'hidden' || paused || buffering || sheet || error || start === null) return undefined;
		const timer = setTimeout(() => setControls('hidden'), controls === 'peek' ? 1500 : HIDE_AFTER_MS);
		return () => clearTimeout(timer);
	}, [buffering, controls, error, paused, poked, sheet, start]);

	// The player opens in landscape; the rotate button turns it to portrait and back.
	useEffect(() => {
		if (!Platform.isTV) navigation.setOptions({ orientation: portrait ? 'portrait' : 'landscape' });
	}, [navigation, portrait]);
	useEffect(() => {
		slide.setValue(page ? 40 : -40);
		Animated.timing(slide, { toValue: 0, duration: 160, useNativeDriver: true }).start();
	}, [page, slide]);

	const seekTo = useCallback((ms: number) => {
		const target = Math.round(Math.max(0, position.current.duration ? Math.min(ms, position.current.duration - 1000) : ms));
		position.current.time = target;
		setTime(target);
		player.current?.seek(target / 1000);
		// Trakt's watching status ends when the runtime it expects runs out: tell it where playback is now.
		if (seekTimer.current) clearTimeout(seekTimer.current);
		seekTimer.current = setTimeout(() => scrobbled.current === 'start' && scrobble('start', true), 2000);
	}, [scrobble]);
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
	// Nothing re-renders a paused player: its "Ends at" moves on with the clock.
	const [, setTick] = useState(0);
	useEffect(() => {
		if (!paused) return undefined;
		const timer = setInterval(() => setTick((n) => n + 1), 15_000);
		return () => clearInterval(timer);
	}, [paused]);
	// The sleep timer pauses, and the screen may sleep again.
	useEffect(() => {
		if (typeof sleep !== 'number') return undefined;
		const timer = setTimeout(() => {
			player.current?.pause();
			save();
			setSleep(null);
			show();
		}, Math.max(0, sleep - Date.now()));
		return () => clearTimeout(timer);
	}, [save, show, sleep]);
	const delay = (type: 'audio' | 'subtitle', ms: number) => {
		setDelays((was) => ({ ...was, [type]: ms }));
		if (type === 'audio') player.current?.setAudioDelay(ms * 1000);
		else player.current?.setSubtitleDelay(ms * 1000);
	};

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
						// While the buttons are up, left and right move between them (and keep them up), except on the seek bar.
						if (!hidden && !seekFocused.current) return show();
						skip(event.eventType === 'left' ? -SKIP_MS : SKIP_MS);
						return show('peek');
					case 'up':
					case 'down':
						return show();
				}
			},
			[countdown, show, skip, toggle]
		)
	);

	/** Plays another video in this player's place: an episode, or another version from `at`. */
	const openCopy = useCallback(
		async (other: LibraryItem, pick: (files: LibraryFile[]) => LibraryFile | undefined, from?: number) => {
			try {
				const files = other.files.length ? other.files : (titles.filesOf(other) ?? (await detail(other.provider, other.id)).files);
				const chosen = pick(files);
				if (!chosen) throw new Error('This copy has no video to open yet.');
				const link = await openFile(other.provider, { ...other, files }, chosen.id);
				if (!isSafeExternalUrl(link)) throw new Error('The provider returned an unsafe file URL.');
				// A sleep timer's time carries on into the next video.
				if (mounted.current) navigation.replace('Player', { url: link, item: { ...other, files }, fileId: chosen.id, at: from, sleep: typeof sleep === 'number' ? sleep : undefined });
			} catch (caught) {
				if (mounted.current) {
					setCountdown(null);
					setError(caught instanceof Error ? caught.message : 'Could not open that video.');
				}
			}
		},
		[detail, navigation, openFile, sleep, titles]
	);
	const playNext = useCallback((copy: EpisodeCopy) => openCopy(copy.item, (files) => files.find((entry) => entry.id === copy.file.id)), [openCopy]);
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
		scrobble('stop');
		if (next && sleep !== 'end') setCountdown(NEXT_IN_S);
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

	/** A round button in the middle: skips and play/pause. */
	const round = (icon: IconName, label: string, onPress: () => void, large = false, preferred = false) => (
		<Pressable accessibilityRole="button" accessibilityLabel={label} hasTVPreferredFocus={Platform.isTV && preferred} onPress={() => { onPress(); show(); }} style={({ focused }) => [local.round, large && local.roundLarge, focused && local.roundFocused]}>
			<Icon name={icon} size={large ? 44 : 30} color="#fff" />
		</Pressable>
	);
	/** An icon button inside a pill; `on` tints a setting that is not the default. */
	const tool = (icon: IconName, label: string, onPress: () => void, on = false) => (
		<Pressable key={icon} accessibilityRole="button" accessibilityLabel={label} onPress={() => { onPress(); show(); }} style={({ focused }) => [local.tool, focused && local.toolFocused]}>
			<Icon name={icon} size={22} color={on ? ACCENT : '#fff'} />
		</Pressable>
	);
	const kind = named?.kind;
	const toolsFirst = [
		next ? tool('skip-next', `Next episode, ${episodeLabel(next)}`, () => void playNext(next)) : null,
		tool('subtitles-outline', 'Subtitles', () => openSheet('subtitle')),
		tool('volume-high', 'Audio track', () => openSheet('audio')),
		tool('speedometer', `Speed, ${rate}x`, () => setSheet('speed'), rate !== 1),
		episodes && episodes.seasons.size ? tool('format-list-bulleted', 'Episodes', () => setSheet('episodes')) : null,
	].filter(Boolean);
	const toolsMore = [
		tool('aspect-ratio', 'Picture size', () => setSheet('fit'), fit !== 'contain'),
		versions.length ? tool('layers-outline', 'Versions', () => setSheet('versions')) : null,
		tool('power-sleep', `Sleep timer, ${sleepLabel(sleep, Date.now(), kind)}`, () => setSheet('sleep'), sleep !== null),
		tool('timer-sync-outline', 'Audio and subtitle delay', () => setSheet('delay'), Boolean(delays.audio || delays.subtitle)),
	].filter(Boolean);
	// A phone has room for the first ones; › slides the pill to the rest. Tablets and TVs show them all.
	const tools = !phone ? [...toolsFirst, ...toolsMore] : page === 0 ? [...toolsFirst, tool('chevron-right', 'More controls', () => setPage(1))] : [tool('chevron-left', 'Back to the first controls', () => setPage(0)), ...toolsMore];

	const probe = probeFor(titles.probesOf(item) ?? [], file) ?? (kind === 'movie' ? filmProbe(titles.probesOf(item) ?? [], item.size) : undefined);
	// The playing track's place in the probe's list, when libVLC lists the same tracks.
	const listedAudio = tracks?.audio.filter((track) => track.id !== -1) ?? [];
	const playingAudio = listedAudio.findIndex((track) => track.id === tracks?.audioIndex);
	const badges = playerBadges(probe, item.filename, baseName(file.name), probe && listedAudio.length === probe.audio.length && playingAudio >= 0 ? playingAudio : undefined);
	const episodeName = current?.ref ? episodeNames?.get(`${current.ref.season}:${current.ref.episode}`) : undefined;
	const subline = current?.ref
		? `S${current.ref.season} E${current.ref.episode}${current.ref.end ? `–E${current.ref.end}` : ''}${episodeName ? ` • ${episodeName}` : ''}`
		: kind === 'movie' && named?.year ? String(named.year) : '';
	const logoHeight = logo ? Math.min(phone ? 44 : 64, (phone ? 200 : 300) / logo) : 0;
	const box = (fit === '16:9' || fit === '4:3') && area.width ? ratioBox(area.width, area.height, fit) : null;

	// Built when their sheet opens: the screen renders every second.
	const versionActions = () => uniqueLabelsOf(
		versions.map(({ item: other, file: copyFile, size, quality }) => {
			const facts = (() => {
				const probes = titles.probesOf(other) ?? [];
				const found = copyFile ? probeFor(probes, copyFile) : filmProbe(probes, other.size);
				return found ? copyFacts(found, other.filename) : null;
			})();
			const label = [...(facts ? [...facts.picture, facts.sound[0]] : [quality]), formatBytes(size).replace('Unknown size', ''), PROVIDER_META[other.provider].label].filter(Boolean).join(' · ');
			return { label, onPress: () => void openCopy(other, (files) => (copyFile ? files.find((entry) => entry.id === copyFile.id) : mainFile(other, files)), position.current.time) };
		})
	);
	const episodeActions = (): SheetAction[] => episodes
		? [...episodes.seasons].flatMap(([season, numbers]) =>
				[...numbers].map(([number, copies]) => {
					const copy = pickCopy(copies, item);
					const playing = current?.ref?.season === season && current.ref.episode === number;
					const name = episodeNames?.get(`${season}:${number}`);
					return { label: `S${season} E${number}${copy.ref?.end ? `–E${copy.ref.end}` : ''}${name ? ` · ${name}` : ''}`, checked: playing, onPress: () => (playing ? undefined : void playNext(copy)) };
				})
			)
		: [];
	const sheetActions = (): SheetAction[] => {
		switch (sheet) {
			case 'apps':
				return otherApps;
			case 'speed':
				return SPEEDS.map((speed) => ({ label: speed === 1 ? 'Normal' : `${speed}x`, checked: rate === speed, onPress: () => setRate(speed) }));
			case 'fit':
				return FITS.map((option) => ({ label: option.label, checked: fit === option.fit, onPress: () => setFit(option.fit) }));
			case 'sleep':
				return [
					{ label: 'Off', checked: sleep === null, onPress: () => setSleep(null) },
					{ label: sleepLabel('end', 0, kind), checked: sleep === 'end', onPress: () => setSleep('end') },
					...SLEEP_MINUTES.map((minutes) => ({ label: `In ${minutes} minutes`, onPress: () => setSleep(Date.now() + minutes * 60_000) })),
				];
			case 'episodes':
				return episodeActions();
			case 'versions':
				return versionActions();
			case 'audio':
			case 'subtitle':
				return trackActions(sheet);
			default:
				return [];
		}
	};
	const SHEET_TITLES = { audio: 'Audio', subtitle: 'Subtitles', apps: 'Open in another app', speed: 'Speed', fit: 'Picture size', sleep: 'Sleep timer', episodes: 'Episodes', versions: 'Other versions', delay: 'Delay' };
	const sheetDetail =
		sheet === 'subtitle' && externalSubs.length ? 'Files of this release are listed after the tracks inside the video.'
		: sheet === 'sleep' && typeof sleep === 'number' ? `Pauses in ${sleepLabel(sleep, Date.now()).replace(' left', '')}.`
		: sheet === 'versions' ? 'Plays on from where this one is.'
		: undefined;
	const signed = (ms: number) => `${ms > 0 ? '+' : ms < 0 ? '−' : ''}${(Math.abs(ms) / 1000).toFixed(2)} s`;
	const textButton = (label: string, onPress: () => void, preferred = false) => (
		<Pressable accessibilityRole="button" accessibilityLabel={label} hasTVPreferredFocus={Platform.isTV && preferred} onPress={onPress} style={({ focused }) => [local.textButton, focused && local.focused]}>
			<Text style={local.textButtonLabel}>{label}</Text>
		</Pressable>
	);

	return (
		<View style={local.screen} onLayout={(event) => setArea({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height })}>
			{start !== null ? (
				<VLCPlayer
					key={attempt}
					ref={player}
					// 16:9 and 4:3 shape the view itself and stretch the picture into it: libVLC's own forced ratio is reset by the wrapper's framing.
					style={box ? { position: 'absolute', ...box } : StyleSheet.absoluteFill}
					resizeMode={box ? 'stretch' : fit === '16:9' || fit === '4:3' ? 'contain' : fit}
					rate={rate}
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
						if (jumpTo.current !== null && length > 0) {
							position.current.time = jumpTo.current * length * 1000;
							jumpTo.current = null;
							return player.current?.seek(position.current.time / 1000);
						}
						// The clock moving is playback started: the trackers hear it once there is a duration to measure progress by.
						if (scrobbled.current === null) scrobble('start');
						// Watched now: the save marks it here first, so a tracker's answer settles that mark rather than a later one sending it again.
						if (length > 0 && currentTime >= length * FINISHED && scrobbled.current !== 'stop') {
							position.current.savedAt = Date.now();
							save();
							scrobble('stop');
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
						// A new player (Try again) starts with none.
						if (delays.audio) player.current?.setAudioDelay(delays.audio * 1000);
						if (delays.subtitle) player.current?.setSubtitleDelay(delays.subtitle * 1000);
						if (scrobbled.current === 'pause') scrobble('start');
						if (soundCheck.current === 'no') {
							soundCheck.current = 'asked';
							player.current?.getTracks();
						}
					}}
					onPaused={() => {
						setPaused(true);
						scrobble('pause');
					}}
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

			{controls !== 'hidden' && start !== null && !error && countdown === null && locked ? (
				// Locked: one button, until it is tapped; nothing else takes a touch.
				<View style={[StyleSheet.absoluteFill, safe]} pointerEvents="box-none">
					<View style={local.top} pointerEvents="box-none">
						<View style={local.pill}>{tool('lock-open-variant-outline', 'Unlock controls', () => setLocked(false))}</View>
					</View>
				</View>
			) : controls !== 'hidden' && start !== null && !error && countdown === null ? (
				<View style={[local.overlay, safe]} pointerEvents="box-none">
					{controls === 'shown' && !Platform.isTV ? (
						<View style={local.top} pointerEvents="box-none">
							<View style={local.pill}>
								{tool('screen-rotation', portrait ? 'Turn to landscape' : 'Turn to portrait', () => setPortrait((was) => !was))}
								{tool('lock-outline', 'Lock controls', () => setLocked(true))}
							</View>
							<Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={() => navigation.goBack()} style={local.back}>
								<Icon name="close" size={22} color="#fff" />
							</Pressable>
						</View>
					) : <View />}
					{controls === 'shown' ? (
						<View style={local.middle} pointerEvents="box-none">
							{round('rewind-10', 'Back 10 seconds', () => skip(-SKIP_MS))}
							{round(paused ? 'play' : 'pause', paused ? 'Play' : 'Pause', toggle, true, true)}
							{round('fast-forward-10', 'Forward 10 seconds', () => skip(SKIP_MS))}
						</View>
					) : null}
					<View style={local.bottom} pointerEvents="box-none">
						{controls === 'shown' ? (
							<View style={local.info} pointerEvents="box-none">
								<View style={local.infoText} pointerEvents="box-none">
									{logo && named ? (
										<Image source={{ uri: logoUrl(named.imdbId) }} resizeMode="contain" accessibilityLabel={named.title} style={{ width: logoHeight * logo, height: logoHeight }} />
									) : logo === null ? (
										<Text numberOfLines={1} style={local.title}>{named?.title ?? baseName(file.name)}</Text>
									) : null}
									{subline ? <Text numberOfLines={1} style={local.subline}>{subline}</Text> : null}
									{badges.length
										? (() => {
												const shown = badges.map((badge) => (
													<View key={badge.label} style={local.badge}>
														<Text style={local.badgeText}>{badge.label}</Text>
														{badge.suffix ? <Text style={local.badgeSuffix}>{badge.suffix}</Text> : null}
													</View>
												));
												// One line on a phone, scrolled sideways; a TV's remote would stop on a scroll view.
												return Platform.isTV ? <View style={local.badges}>{shown}</View> : <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={local.badges}>{shown}</ScrollView>;
											})()
										: null}
								</View>
								{/* ponytail: Hermes formats by the locale; Android's own 24-hour switch needs expo-localization's uses24hourClock (a native module: next store build). */}
								{duration ? <Text style={local.endsAt}>Ends at {new Date(endsAt(Date.now(), shownTime, duration, rate)).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</Text> : null}
							</View>
						) : null}
						{(() => {
							const bar = (
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
							);
							// On a TV the bar takes focus between the middle buttons and the toolbar: left and right skip there.
							return Platform.isTV ? (
								<Pressable accessibilityRole="adjustable" accessibilityLabel="Seek" onFocus={() => (seekFocused.current = true)} onBlur={() => (seekFocused.current = false)} onPress={() => { toggle(); show(); }} style={local.barFocus}>
									{bar}
								</Pressable>
							) : bar;
						})()}
						<View style={local.toolRow} pointerEvents="box-none">
							{controls === 'shown' ? <Animated.View style={[local.pill, { transform: [{ translateX: slide }] }]}>{tools}</Animated.View> : <View />}
							<View style={local.timePill}>
								<Text style={local.time}>{clock(shownTime)} / {duration ? clock(duration) : '--:--'}</Text>
							</View>
						</View>
					</View>
				</View>
			) : null}

			{start === null && resumeAt ? (
				<View style={local.dialog}>
					<Text style={local.dialogTitle} numberOfLines={2}>{title}</Text>
					{textButton(`Resume from ${'ms' in resumeAt ? clock(resumeAt.ms) : `${Math.round(resumeAt.fraction * 100)}%`}`, () => begin(resumeAt), true)}
					{textButton('Start over', () => begin(null))}
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
						// A new player starts at normal speed: the wrapper may set a rate before its player exists.
						setRate(1);
						setAttempt((n) => n + 1);
					}, true)}
					{otherApps.length ? textButton('Open in another app', () => setSheet('apps')) : null}
					{textButton('Back', () => navigation.goBack())}
				</View>
			) : null}

			{sheet && sheet !== 'delay' ? (
				<ActionSheet landscape={!portrait} title={SHEET_TITLES[sheet]} detail={sheetDetail} actions={sheetActions()} onClose={() => setSheet(null)} />
			) : null}

			{sheet === 'delay' ? (
				<Modal visible transparent animationType="fade" supportedOrientations={portrait ? undefined : ['landscape']} onRequestClose={() => setSheet(null)}>
					<TvScale>
						<PlainPressable focusable={false} accessibilityLabel="Close delay" onPress={() => setSheet(null)} style={local.modalBack}>
							<PlainPressable focusable={false} onPress={() => undefined} style={local.delayPanel}>
								<View style={local.delayHead}>
									<Text style={[local.dialogTitle, { flex: 1 }]}>Delay</Text>
									<Pressable accessibilityRole="button" accessibilityLabel="Close delay" onPress={() => setSheet(null)} hitSlop={10}><Icon name="close" size={22} color="#a6b2c8" /></Pressable>
								</View>
								{(['audio', 'subtitle'] as const).map((type, n) => (
									<View key={type} style={local.delayRow}>
										<Text style={[local.dialogText, { flex: 1 }]}>{type === 'audio' ? 'Audio' : 'Subtitles'}</Text>
										<Pressable accessibilityRole="button" accessibilityLabel={`${type === 'audio' ? 'Audio' : 'Subtitles'} earlier`} hasTVPreferredFocus={Platform.isTV && n === 0} onPress={() => delay(type, delays[type] - DELAY_STEP_MS)} style={({ focused }) => [local.tool, local.toolOutlined, focused && local.toolFocused]}>
											<Icon name="minus" size={20} color="#fff" />
										</Pressable>
										<Text style={local.delayValue}>{signed(delays[type])}</Text>
										<Pressable accessibilityRole="button" accessibilityLabel={`${type === 'audio' ? 'Audio' : 'Subtitles'} later`} onPress={() => delay(type, delays[type] + DELAY_STEP_MS)} style={({ focused }) => [local.tool, local.toolOutlined, focused && local.toolFocused]}>
											<Icon name="plus" size={20} color="#fff" />
										</Pressable>
									</View>
								))}
								<Text style={[local.dialogText, { fontSize: 12.5 }]}>Plus plays it later, minus sooner.</Text>
								{textButton('Reset', () => {
									delay('audio', 0);
									delay('subtitle', 0);
								})}
							</PlainPressable>
						</PlainPressable>
					</TvScale>
				</Modal>
			) : null}
		</View>
	);
}

/** Translucent like the app's dark surfaces, with a thin light edge, so they read over any picture. */
const GLASS = { backgroundColor: 'rgba(21,29,49,0.55)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)' } as const;

const local = StyleSheet.create({
	screen: { flex: 1, backgroundColor: '#000' },
	center: { position: 'absolute', alignSelf: 'center', top: '45%' },
	overlay: { ...StyleSheet.absoluteFill, justifyContent: 'space-between', backgroundColor: 'rgba(0,0,0,0.35)' },
	top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 10, paddingHorizontal: 20, paddingTop: 14 },
	pill: { ...GLASS, flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', borderRadius: 24, padding: 3, gap: 2 },
	tool: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
	toolOutlined: { borderWidth: 1, borderColor: 'rgba(255,255,255,0.3)' },
	toolFocused: { backgroundColor: 'rgba(255,255,255,0.28)' },
	back: { ...GLASS, width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center' },
	middle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 40 },
	round: { width: 58, height: 58, borderRadius: 29, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(11,16,32,0.4)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.35)' },
	roundLarge: { width: 76, height: 76, borderRadius: 38 },
	roundFocused: { backgroundColor: 'rgba(255,255,255,0.3)', borderColor: '#fff' },
	bottom: { paddingHorizontal: 20, paddingBottom: 12, gap: 2 },
	info: { flexDirection: 'row', alignItems: 'flex-end', gap: 12 },
	infoText: { flex: 1, gap: 4, alignItems: 'flex-start' },
	title: { color: '#fff', fontSize: 20, fontWeight: '800' },
	subline: { color: '#e5e9f2', fontSize: 14, fontWeight: '600' },
	badges: { flexDirection: 'row', flexWrap: Platform.isTV ? 'wrap' : 'nowrap', gap: 5, paddingVertical: 1 },
	badge: { flexDirection: 'row', alignItems: 'flex-start', height: 20, paddingHorizontal: 6, borderRadius: 5, backgroundColor: 'rgba(255,255,255,0.12)', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.35)' },
	badgeText: { color: '#fff', fontSize: 11.5, lineHeight: 19, fontWeight: '700' },
	badgeSuffix: { color: '#cfd6e4', fontSize: 7.5, lineHeight: 10, fontWeight: '800', marginLeft: 2, marginTop: 2 },
	endsAt: { color: '#e5e9f2', fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums'] },
	bar: { height: 32, justifyContent: 'center' },
	barFocus: { borderRadius: 16, paddingHorizontal: 8 },
	track: { height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.35)', overflow: 'hidden' },
	fill: { height: 4, backgroundColor: ACCENT },
	knob: { position: 'absolute', width: 14, height: 14, borderRadius: 7, marginLeft: -7, backgroundColor: ACCENT },
	toolRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
	timePill: { ...GLASS, borderRadius: 18, paddingHorizontal: 12, height: 34, justifyContent: 'center' },
	time: { color: '#fff', fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums'] },
	focused: { backgroundColor: 'rgba(255,255,255,0.25)' },
	dialog: { position: 'absolute', alignSelf: 'center', top: '20%', width: 340, maxWidth: '90%', padding: 18, gap: 10, borderRadius: 14, backgroundColor: 'rgba(21,29,49,0.95)' },
	dialogTitle: { color: '#fff', fontSize: 17, fontWeight: '700' },
	dialogText: { color: '#a6b2c8', fontSize: 14 },
	textButton: { minHeight: 44, borderRadius: 10, paddingHorizontal: 14, justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.3)' },
	textButtonLabel: { color: '#fff', fontSize: 15, fontWeight: '700' },
	modalBack: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.35)' },
	delayPanel: { width: 340, maxWidth: '90%', padding: 18, gap: 10, borderRadius: 14, backgroundColor: 'rgba(21,29,49,0.97)' },
	delayHead: { flexDirection: 'row', alignItems: 'center' },
	delayRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
	delayValue: { color: '#fff', fontSize: 15, fontWeight: '700', fontVariant: ['tabular-nums'], minWidth: 64, textAlign: 'center' },
});
