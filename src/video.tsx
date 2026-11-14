import type { ComponentType, RefAttributes } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import VLCPlayer, { type VLCChapter, type VLCPlayerRef, type VLCPlayerTracks } from '@lunarr/vlc-player';

/**
 * The built-in player's engine: libVLC 3 (@lunarr/vlc-player) on iPhone, iPad and Apple TV, Media3 on
 * Android (video.android.tsx, which Metro picks there). Both take these props and answer these calls.
 * Both are .tsx: Metro tries every platform for one extension before the next, so a video.ts would win over video.android.tsx.
 */
export type PlayerRef = Pick<VLCPlayerRef, 'play' | 'pause' | 'seek' | 'getTracks' | 'selectAudioTrack' | 'selectSubtitleTrack' | 'setSubtitleFile' | 'setAudioDelay' | 'setSubtitleDelay' | 'enterPictureInPicture'>;
export type PlayerTracks = VLCPlayerTracks;
export type Chapter = VLCChapter;

export interface PlayerProps {
	style?: StyleProp<ViewStyle>;
	resizeMode?: 'contain' | 'cover' | 'stretch' | 'center';
	rate?: number;
	/** Pauses at this wall-clock time (ms; 0 for none), also where JS timers wait: Android's picture in picture. */
	pauseAt?: number;
	/** `mediaOptions` are libVLC's; the start (`:start-time=<s>`) is the one Android reads too. */
	source: { uri: string; isNetwork?: boolean; mediaOptions?: string[] };
	continueAudioInBackground?: boolean;
	showNowPlaying?: boolean;
	progressUpdateInterval?: number;
	/** Seconds. */
	onProgress?: (event: { currentTime: number; duration: number }) => void;
	onBuffer?: (event: { isBuffering?: boolean }) => void;
	onPlaying?: () => void;
	onPaused?: () => void;
	onEnd?: () => void;
	onTracks?: (tracks: PlayerTracks) => void;
	/** `message` says why when the engine knows (Android). */
	onError?: (event: { message?: string }) => void;
}

export default VLCPlayer as unknown as ComponentType<PlayerProps & RefAttributes<PlayerRef>>;
