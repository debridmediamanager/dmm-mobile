import { audioCodec, channelLabel, languageName, subtitleCodec } from './mediaInfo';
import type { PlayerTracks } from './video';

/** A track as modules/dmm-player's VideoView reports it: Media3's Format, with its place in the list as the id. */
export interface NativeTrack {
	id: number;
	/** BCP 47 ("en", "pt-BR"), "und" or empty. */
	language: string;
	/** The container's track name. */
	label: string;
	/** Media3's MIME type ("audio/true-hd"; a subtitle's source format, "application/pgs"). */
	mime: string;
	channels: number;
	forced: boolean;
	supported: boolean;
}

export interface NativeTracks {
	audio: NativeTrack[];
	audioIndex: number;
	subtitle: NativeTrack[];
	subtitleIndex: number;
	chapters: { name: string; time: number }[];
}

// Media3's MIME types as ffprobe's codec names, which mediaInfo.ts labels ("DD+ Atmos", "DTS-HD MA", "PGS").
const AUDIO: Record<string, [string, string?]> = {
	'audio/true-hd': ['truehd'],
	'audio/eac3-joc': ['eac3', 'Atmos'],
	'audio/eac3': ['eac3'],
	'audio/ac3': ['ac3'],
	'audio/ac4': ['ac4'],
	'audio/vnd.dts': ['dts'],
	'audio/vnd.dts.hd': ['dts', 'DTS-HD'],
	'audio/vnd.dts.hd;profile=lbr': ['dts', 'DTS Express'],
	'audio/vnd.dts.uhd;profile=p2': ['dts', 'DTS:X'],
	'audio/mp4a-latm': ['aac'],
	'audio/opus': ['opus'],
	'audio/flac': ['flac'],
	'audio/vorbis': ['vorbis'],
	'audio/mpeg': ['mp3'],
	'audio/mpeg-L2': ['mp2'],
	'audio/raw': ['pcm_s16le'],
	'audio/alac': ['alac'],
};
const SUBTITLE: Record<string, string> = {
	'application/pgs': 'hdmv_pgs_subtitle',
	'application/x-subrip': 'subrip',
	'text/x-ssa': 'ass',
	'application/vobsub': 'dvd_subtitle',
	'text/vtt': 'webvtt',
	'application/dvbsubs': 'dvb_subtitle',
	'application/x-mp4-vtt': 'mov_text',
	'application/x-quicktime-tx3g': 'mov_text',
};

const language = (code: string) => (code && code !== 'und' ? languageName(code.split('-')[0]) : '');
const join = (parts: (string | undefined)[]) => parts.filter(Boolean).join(' · ');
/** What the container's name already says ("English (SDH)", "DTS-HD MA 5.1") is not said again. */
const unsaid = (label: string, part: string) => (part && !label.toLowerCase().includes(part.split(/[ -]/)[0].toLowerCase()) ? part : '');

/** "English · TrueHD Atmos 7.1"; "Commentary · English · DD 2.0". */
export function audioName(track: NativeTrack): string {
	const [codec, profile] = AUDIO[track.mime] ?? [track.mime.replace(/^audio\//, '')];
	const sound = [audioCodec({ codec, profile, title: track.label }), track.channels ? channelLabel({ channels: track.channels }) : undefined].filter(Boolean).join(' ');
	return join([track.label, unsaid(track.label, language(track.language)), unsaid(track.label, sound)]) || `Track ${track.id + 1}`;
}

/** "English · Forced · PGS"; "Signs & Songs · English · ASS". */
export function subtitleName(track: NativeTrack): string {
	const format = subtitleCodec(SUBTITLE[track.mime] ?? track.mime.replace(/^(text|application)\/(x-)?/, ''));
	return join([track.label, unsaid(track.label, language(track.language)), track.forced ? unsaid(track.label, 'Forced') : '', unsaid(track.label, format)]) || `Track ${track.id + 1}`;
}

/** A name every track carries (often the release's) tells none apart: dropped. */
const distinct = (tracks: NativeTrack[]): NativeTrack[] =>
	tracks.length > 1 && tracks.every((track) => track.label === tracks[0].label) ? tracks.map((track) => ({ ...track, label: '' })) : tracks;

/** The tracks in @lunarr/vlc-player's shape, which the player screen reads: id -1 first is "No sound" and "Off", as libVLC lists them. */
export const playerTracks = (native: NativeTracks): PlayerTracks => ({
	audio: [{ id: -1, name: '' }, ...distinct(native.audio).map((track) => ({ id: track.id, name: audioName(track) }))],
	audioIndex: native.audioIndex,
	subtitle: [{ id: -1, name: '' }, ...distinct(native.subtitle).map((track) => ({ id: track.id, name: subtitleName(track) }))],
	subtitleIndex: native.subtitleIndex,
	chapters: native.chapters,
	chapterIndex: -1,
});

/** Where playback starts, in ms, from libVLC's `:start-time=<seconds>` option the screen passes. */
export function startMs(mediaOptions: readonly string[] = []): number {
	const seconds = mediaOptions.map((option) => /^:start-time=([\d.]+)$/.exec(option)?.[1]).find(Boolean);
	return seconds ? Math.round(Number(seconds) * 1000) : 0;
}

/** "10-bit H.264", "VC-1", "Dolby Vision profile 5": what a picture is, from Media3's codecs string or MIME type. */
export function pictureName(codec: string): string {
	const avc = /^avc[13]\.([0-9a-f]{2})/i.exec(codec);
	if (avc) return Number.parseInt(avc[1], 16) === 110 ? '10-bit H.264' : Number.parseInt(avc[1], 16) === 122 || Number.parseInt(avc[1], 16) === 244 ? '4:2:2 or 4:4:4 H.264' : 'H.264';
	const dv = /^dv(?:he|h1|av|a1)\.(\d\d)/i.exec(codec);
	if (dv) return `Dolby Vision profile ${Number(dv[1])}`;
	if (/^(hvc1|hev1)/i.test(codec) || codec === 'video/hevc') return 'HEVC';
	if (/wvc1|vc1/i.test(codec)) return 'VC-1';
	if (/mpeg2/i.test(codec)) return 'MPEG-2';
	if (/^av01|video\/av01/i.test(codec)) return 'AV1';
	if (/^vp09|video\/x-vnd\.on2\.vp9/i.test(codec)) return 'VP9';
	if (/mp4v|video\/mp4v-es|divx|xvid/i.test(codec)) return 'MPEG-4 (DivX/Xvid)';
	return codec.replace(/^video\//, '').toUpperCase() || 'its video';
}

/** The error screen's text for what Media3 reported (PlaybackException's error code names). */
export function errorText(error: { code?: string; detail?: string; kind?: string }): string {
	const code = error.code ?? '';
	const what = error.kind === 'audio' ? 'sound' : 'picture';
	const named = error.detail ? ` (${error.kind === 'audio' ? error.detail.replace(/^audio\//, '') : pictureName(error.detail)})` : '';
	if (code === 'VIDEO_UNSUPPORTED') return `This device has no decoder for its picture${named}.`;
	if (/^ERROR_CODE_DECOD/.test(code)) return `This device could not decode its ${what}${named}.`;
	if (/^ERROR_CODE_IO_BAD_HTTP_STATUS/.test(code)) return 'The provider stopped serving the file.';
	if (/^ERROR_CODE_IO_/.test(code)) return 'The stream stopped arriving.';
	if (/^ERROR_CODE_PARSING_/.test(code)) return 'This file could not be read.';
	if (/^ERROR_CODE_AUDIO_TRACK/.test(code)) return 'The sound could not be played on this device.';
	return 'This file could not be played here.';
}
