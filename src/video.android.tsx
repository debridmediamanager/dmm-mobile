import { forwardRef, useImperativeHandle, useRef, type Ref } from 'react';
import type { NativeSyntheticEvent, StyleProp, ViewStyle } from 'react-native';
import { requireNativeView } from 'expo';
import { errorText, playerTracks, startMs, type NativeTracks } from './androidPlayer';
import type { PlayerProps, PlayerRef } from './video';

type Event<T> = (event: NativeSyntheticEvent<T>) => void;
interface NativeProps {
	style?: StyleProp<ViewStyle>;
	source: { uri: string; startMs: number };
	rate?: number;
	pauseAt?: number;
	resizeMode?: string;
	onProgress?: Event<{ currentTime: number; duration: number }>;
	onBuffer?: Event<{ isBuffering: boolean }>;
	onPlaying?: Event<object>;
	onPaused?: Event<object>;
	onEnd?: Event<object>;
	onTracks?: Event<NativeTracks>;
	onError?: Event<{ code: string; detail: string; kind: string }>;
}
type NativeRef = { [name in keyof PlayerRef]: (...args: Parameters<PlayerRef[name]>) => Promise<void> };

/** modules/dmm-player: Media3 with FFmpeg's audio decoders and libass, in the shape the screen drives libVLC elsewhere. */
const NativeVideo = requireNativeView<NativeProps & { ref?: Ref<NativeRef> }>('DmmPlayer');

export default forwardRef<PlayerRef, PlayerProps>(function Video({ source, style, resizeMode, rate, pauseAt, onProgress, onBuffer, onPlaying, onPaused, onEnd, onTracks, onError }, ref) {
	const native = useRef<NativeRef>(null);
	// Calls before the view exists, or after it went, do nothing (as libVLC's commands did).
	const call = <K extends keyof PlayerRef>(name: K) => (...args: Parameters<PlayerRef[K]>) => void native.current?.[name](...args).catch(() => undefined);
	useImperativeHandle(ref, () => ({
		play: call('play'),
		pause: call('pause'),
		seek: call('seek'),
		getTracks: call('getTracks'),
		selectAudioTrack: call('selectAudioTrack'),
		selectSubtitleTrack: call('selectSubtitleTrack'),
		setSubtitleFile: call('setSubtitleFile'),
		setAudioDelay: call('setAudioDelay'),
		setSubtitleDelay: call('setSubtitleDelay'),
		enterPictureInPicture: call('enterPictureInPicture'),
	}));
	return (
		<NativeVideo
			ref={native}
			style={style}
			source={{ uri: source.uri, startMs: startMs(source.mediaOptions) }}
			resizeMode={resizeMode}
			rate={rate}
			pauseAt={pauseAt}
			onProgress={(event) => onProgress?.(event.nativeEvent)}
			onBuffer={(event) => onBuffer?.(event.nativeEvent)}
			onPlaying={() => onPlaying?.()}
			onPaused={() => onPaused?.()}
			onEnd={() => onEnd?.()}
			onTracks={(event) => onTracks?.(playerTracks(event.nativeEvent))}
			onError={(event) => onError?.({ message: errorText(event.nativeEvent) })}
		/>
	);
});
