import { filePath, formatBytes } from './core';
import type { LibraryFile } from './model';
import type { SyncIdentity } from './sync';
import { LoginRefused, type Post } from './titles';
import { DMM_ORIGIN } from './tvLink';

/**
 * What ffprobe knows of each copy, from the probes DMM stores per release (zurg's snapshots and sponsor apps'
 * probes, /api/library/mediainfo). The rules follow DMM web's media info panel and its Stremio stream titles
 * (src/components/showInfo/utils.ts, src/utils/streamMetadata.ts): Dolby Vision from the DOVI record, channel
 * labels, DD/DD+ names. Probes come both as ffprobe's names and as ffmpeg's numeric profile ids.
 */

interface RawStream {
	codec_type?: string;
	codec_name?: string;
	profile?: string | number;
	width?: number;
	height?: number;
	pix_fmt?: string;
	bits_per_raw_sample?: string | number;
	color_transfer?: string;
	avg_frame_rate?: string;
	r_frame_rate?: string;
	bit_rate?: string | number;
	channels?: number;
	channel_layout?: string;
	side_data_list?: Record<string, unknown>[] | null;
	tags?: Record<string, string> | null;
	disposition?: Record<string, number> | null;
}
interface RawProbe {
	streams?: RawStream[];
	format?: { duration?: string | number; bit_rate?: string | number; format_name?: string };
}

export interface Track {
	codec: string;
	profile?: string;
	language?: string;
	title?: string;
	channels?: number;
	layout?: string;
	default?: true;
	forced?: true;
	sdh?: true;
	commentary?: true;
}
export interface Video {
	codec: string;
	profile?: string;
	width: number;
	height: number;
	bitDepth?: number;
	fps?: number;
	bitrate?: number;
	transfer?: string;
	/** Dolby Vision's profile and its base layer's fallback (dv_bl_signal_compatibility_id). */
	dv?: { profile: number; compat: number };
}
/** One probed file of a release, kept on the device: the parts of ffprobe's answer the app shows. */
export interface FileProbe {
	path: string;
	bytes: number;
	video?: Video;
	audio: Track[];
	subs: Track[];
	/** Seconds. */
	duration?: number;
	/** Bits a second, the whole file. */
	bitrate?: number;
	container?: string;
}

const num = (value: unknown): number | undefined => {
	const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
	return Number.isFinite(n) && n > 0 ? n : undefined;
};
const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : typeof value === 'number' ? String(value) : undefined);
const flag = (on: unknown): true | undefined => (on === 1 || on === true ? true : undefined);

/** A stream's own bitrate, else mkvmerge's statistics tag (MKV streams carry no bit_rate). */
const bitrateOf = (stream: RawStream): number | undefined => num(stream.bit_rate) ?? num(Object.entries(stream.tags ?? {}).find(([key]) => /^BPS(-|$)/i.test(key))?.[1]);

const fpsOf = (rate: string | undefined): number | undefined => {
	const [a, b] = (rate ?? '').split('/').map(Number);
	return a > 0 && b > 0 ? Math.round((a / b) * 1000) / 1000 : undefined;
};

/**
 * A track's own label. Muxers stamp the film's title (or the scene name) on every stream: that says nothing
 * about the track.
 */
const labelOf = (title: string | undefined, stamp: string | undefined): string | undefined => (!title || title === stamp || /^\S+\.\S+\.\S+$/.test(title) ? undefined : title);

function trackOf(stream: RawStream, stamp: string | undefined): Track {
	const tags = stream.tags ?? {};
	const d = stream.disposition ?? {};
	const language = text(tags.language ?? tags.LANGUAGE)?.toLowerCase();
	return {
		codec: stream.codec_name ?? '',
		profile: text(stream.profile),
		language,
		title: labelOf(text(tags.title ?? tags.TITLE), stamp),
		channels: num(stream.channels),
		layout: text(stream.channel_layout),
		default: flag(d.default),
		forced: flag(d.forced),
		sdh: flag(d.hearing_impaired),
		commentary: flag(d.comment),
	};
}

const ART = /^(mjpeg|png|bmp|gif|webp)$/;

/** A probe as the app keeps it. Cover art is not the picture. */
export function summarize(path: string, bytes: number, raw: unknown): FileProbe {
	const probe = (raw ?? {}) as RawProbe;
	const streams = Array.isArray(probe.streams) ? probe.streams : [];
	const picture = streams.find((s) => s.codec_type === 'video' && !ART.test(s.codec_name ?? '') && !s.disposition?.attached_pic);
	let video: Video | undefined;
	if (picture) {
		const depth = /(\d{2})(le|be)$/.exec(picture.pix_fmt ?? '')?.[1] ?? (picture.pix_fmt === 'p010' ? '10' : undefined) ?? picture.bits_per_raw_sample;
		const dv = (picture.side_data_list ?? []).find((side) => num(side?.dv_profile) !== undefined);
		video = {
			codec: picture.codec_name ?? '',
			profile: text(picture.profile),
			width: num(picture.width) ?? 0,
			height: num(picture.height) ?? 0,
			bitDepth: num(depth),
			fps: fpsOf(picture.avg_frame_rate) ?? fpsOf(picture.r_frame_rate),
			bitrate: bitrateOf(picture),
			transfer: text(picture.color_transfer),
			dv: dv ? { profile: Number(dv.dv_profile), compat: Number(dv.dv_bl_signal_compatibility_id) || 0 } : undefined,
		};
	}
	const stamp = text(picture?.tags?.title);
	return {
		path,
		bytes,
		video,
		audio: streams.filter((s) => s.codec_type === 'audio').map((s) => trackOf(s, stamp)),
		subs: streams.filter((s) => s.codec_type === 'subtitle').map((s) => trackOf(s, stamp)),
		duration: num(probe.format?.duration),
		bitrate: num(probe.format?.bit_rate),
		container: text(probe.format?.format_name),
	};
}

/** DMM's answer for a batch of hashes: each release's probed files, keyed as DMM keys them. */
export type MediaInfoAnswer = { releases?: Record<string, { files?: Record<string, { path?: string; bytes?: number; MediaInfo?: unknown }> }> };

export const releaseProbes = (release: NonNullable<MediaInfoAnswer['releases']>[string] | undefined): FileProbe[] =>
	Object.values(release?.files ?? {})
		.filter((file) => typeof file?.path === 'string' && typeof file.bytes === 'number')
		.map((file) => summarize(file.path!, file.bytes!, file.MediaInfo));

const baseName = (path: string) => (path.split('/').pop() ?? path).toLowerCase();

/**
 * The probe of one file of a copy: by its exact size, as storedProbes intends (another provider lists the same
 * file under another folder), the name settling a tie. A file whose size is unknown goes by name alone.
 */
export function probeFor(probes: readonly FileProbe[], file: Pick<LibraryFile, 'name' | 'path' | 'size'>): FileProbe | undefined {
	const name = baseName(filePath(file.name, file.path));
	const pool = file.size > 0 ? probes.filter((probe) => probe.bytes === file.size) : probes;
	if (pool.length === 1 && file.size > 0) return pool[0];
	const named = pool.filter((probe) => baseName(probe.path) === name);
	return named.length === 1 ? named[0] : undefined;
}

/**
 * A film copy's probe without its file list: the largest probed file (DMM's Stremio titles take it too), when
 * it is most of the release. A probe of only the extras (a pack's first pass reached the 3-minute introduction)
 * would describe something else.
 */
export function filmProbe(probes: readonly FileProbe[], releaseBytes: number): FileProbe | undefined {
	const largest = [...probes].sort((a, b) => b.bytes - a.bytes)[0];
	return largest && (!releaseBytes || largest.bytes >= releaseBytes * 0.4) ? largest : undefined;
}

// --- labels -------------------------------------------------------------------------------------------------

/** ISO 639-1 code shown on a row, the other codes and spellings ffprobe gives, then the language's name. */
const LANGUAGES =
	'en eng english English|ja jpn japanese Japanese|fr fre fra french French|de ger deu german German|es spa spanish Spanish|it ita italian Italian|' +
	'pt por portuguese Portuguese|ru rus russian Russian|uk ukr Ukrainian|zh chi zho chinese Chinese|ko kor korean Korean|hi hin Hindi|ar ara Arabic|' +
	'nl dut nld Dutch|sv swe Swedish|no nor nob nno Norwegian|da dan Danish|fi fin Finnish|pl pol polish Polish|cs cze ces Czech|sk slo slk Slovak|' +
	'hu hun Hungarian|tr tur Turkish|el gre ell Greek|he heb Hebrew|th tha Thai|vi vie Vietnamese|id ind Indonesian|ms may msa Malay|' +
	'fil fil tgl Filipino|ro rum ron rom Romanian|bg bul Bulgarian|hr hrv Croatian|sr srp Serbian|sl slv Slovenian|et est Estonian|lv lav Latvian|' +
	'lt lit Lithuanian|is ice isl Icelandic|ca cat Catalan|eu baq eus Basque|gl glg Galician|fa per fas Persian|ur urd Urdu|ta tam Tamil|te tel Telugu|' +
	'ml mal Malayalam|kn kan Kannada|bn ben Bengali|mr mar Marathi|pa pan Punjabi|gu guj Gujarati|sq alb sqi Albanian|hy arm hye Armenian|' +
	'ka geo kat Georgian|mk mac mkd Macedonian|bs bos Bosnian|az aze Azerbaijani|kk kaz Kazakh|km khm Khmer|ky kir Kyrgyz|la lat Latin|ga gle Irish|' +
	'cy wel cym Welsh|sa san Sanskrit|ab abk Abkhazian|my bur mya Burmese|lo lao Lao|mn mon Mongolian|ne nep Nepali|si sin Sinhala|sw swa Swahili|' +
	'af afr Afrikaans|be bel Belarusian|uz uzb Uzbek|tl tgl Tagalog';
const LANGUAGE = new Map<string, { code: string; name: string }>();
for (const entry of LANGUAGES.split('|')) {
	const words = entry.split(' ');
	const known = { code: words[0].toUpperCase(), name: words[words.length - 1] };
	for (const alias of words.slice(0, -1)) if (!LANGUAGE.has(alias)) LANGUAGE.set(alias, known);
}
/** No language to name: undetermined, several, none (music, effects), or a muxer's guess. */
const NO_LANGUAGE = new Set(['', 'und', 'mul', 'zxx', 'unknown', 'mis']);

/** "EN" for a row; an unknown code as it is, upper-cased; nothing for und/mul/zxx. */
export const languageCode = (language: string | undefined): string | undefined =>
	!language || NO_LANGUAGE.has(language) ? undefined : (LANGUAGE.get(language)?.code ?? language.toUpperCase());

/** "English" for the details view. */
export function languageName(language: string | undefined): string {
	if (language === 'zxx') return 'No language';
	if (!language || NO_LANGUAGE.has(language)) return 'Unknown language';
	return LANGUAGE.get(language)?.name ?? language.toUpperCase();
}

/** "EN, JA" or "EN, ES +3": each language once, in track order. */
function languageList(tracks: readonly Track[]): string {
	const codes = [...new Set(tracks.map((track) => languageCode(track.language)).filter((code): code is string => Boolean(code)))];
	return codes.length > 3 ? `${codes.slice(0, 2).join(', ')} +${codes.length - 2}` : codes.join(', ');
}

/** DMM's channel labels, the layout's own number first (a 7-channel track is 6.1, not 7.0). */
export function channelLabel(track: Pick<Track, 'channels' | 'layout'>): string | undefined {
	const layout = track.layout?.toLowerCase() ?? '';
	const named = /(\d+\.\d)/.exec(layout)?.[1];
	if (named) return named;
	if (layout.includes('stereo')) return '2.0';
	if (layout.includes('mono')) return '1.0';
	const n = track.channels;
	if (!n) return undefined;
	return n === 8 ? '7.1' : n === 6 ? '5.1' : `${n}.0`;
}

// ffmpeg's profile ids, for probes that carry numbers (AV_PROFILE_DTS_*, AV_PROFILE_*_ATMOS).
const DTS: Record<string, string> = { '20': 'DTS', '30': 'DTS-ES', '40': 'DTS 96/24', '50': 'DTS-HD HRA', '60': 'DTS-HD MA', '61': 'DTS:X', '62': 'DTS:X IMAX', '70': 'DTS Express' };
const AUDIO: Record<string, string> = { aac: 'AAC', ac3: 'DD', eac3: 'DD+', truehd: 'TrueHD', dts: 'DTS', flac: 'FLAC', opus: 'Opus', vorbis: 'Vorbis', mp3: 'MP3', mp2: 'MP2', alac: 'ALAC', wmav2: 'WMA' };

/** "TrueHD Atmos", "DTS-HD MA", "DD+ Atmos", "HE-AAC". */
export function audioCodec(track: Pick<Track, 'codec' | 'profile' | 'title'>): string {
	const codec = track.codec.toLowerCase();
	const profile = track.profile ?? '';
	if (codec === 'dts') {
		if (/dts:x imax/i.test(profile)) return 'DTS:X IMAX';
		if (/dts:x/i.test(profile)) return 'DTS:X';
		return DTS[profile] ?? (/^dts/i.test(profile) ? profile : 'DTS');
	}
	if (codec === 'truehd' || codec === 'eac3') {
		const atmos = /atmos/i.test(profile) || profile === '30' || /\batmos\b/i.test(track.title ?? '');
		return `${AUDIO[codec]}${atmos ? ' Atmos' : ''}`;
	}
	if (codec === 'aac' && /^he-aac/i.test(profile)) return profile.replace(/^he-aac/i, 'HE-AAC');
	if (codec === 'aac' && profile === '4') return 'HE-AAC';
	if (codec.startsWith('pcm_')) return 'PCM';
	return AUDIO[codec] ?? codec.toUpperCase();
}

const SUBS: Record<string, string> = { hdmv_pgs_subtitle: 'PGS', subrip: 'SRT', ass: 'ASS', ssa: 'SSA', dvd_subtitle: 'VobSub', mov_text: 'MP4 text', webvtt: 'WebVTT', dvb_subtitle: 'DVB', text: 'Text' };
export const subtitleCodec = (codec: string): string => SUBS[codec] ?? codec.toUpperCase();

const VIDEO: Record<string, string> = { h264: 'H264', h265: 'H265', hevc: 'HEVC', av1: 'AV1', vp9: 'VP9', mpeg4: 'MPEG4', xvid: 'XviD', vc1: 'VC-1', mpeg2video: 'MPEG-2' };

/** By the picture's longer side as much as its height: a 3840x1606 scope film is 4K, not 1440p. */
export function resolutionLabel(video: Pick<Video, 'width' | 'height'>): string {
	const { width: w, height: h } = video;
	if (w >= 3200 || h >= 1800) return '4K';
	if (w >= 1800 || h >= 1000) return '1080p';
	if (w >= 1200 || h >= 700) return '720p';
	return h ? 'SD' : '';
}

const nameTag = (name: string): string => {
	if (/hdr10(\+|plus|p\b)/i.test(name)) return 'HDR10+';
	if (/\b(dv|dovi|dolby.?vision)\b/i.test(name)) return 'DV';
	if (/\bhlg\b/i.test(name)) return 'HLG';
	return /\bhdr(10)?\b/i.test(name) ? 'HDR' : '';
};

/**
 * The picture's dynamic range. The probe decides when it says anything (a DOVI record or a transfer); many
 * stored probes carry neither, and then the release name's tag stands, as on a row with no probe. HDR10+ lives in
 * frame metadata a stream probe cannot see, so it comes from the name only on top of an HDR10 picture.
 * `fromName`: what of the label is the release name's, not the probe's: all of it, or the + of HDR10+.
 */
export function dynamicRange(video: Video | undefined, name: string): { label: string; fromName?: 'all' | 'HDR10+' } {
	const tag = nameTag(name);
	const pq = video?.transfer === 'smpte2084';
	const hdr10 = tag === 'HDR10+' ? 'HDR10+' : 'HDR10';
	if (video?.dv) {
		const { profile, compat } = video.dv;
		const base = `DV P${profile}${compat > 0 && profile !== 7 ? `.${compat}` : ''}`;
		const fallback = compat === 1 || compat === 6 || (!compat && profile !== 5 && pq) ? hdr10 : compat === 4 ? 'HLG' : compat === 2 ? 'SDR' : '';
		return { label: fallback ? `${base} + ${fallback}` : base, fromName: fallback === 'HDR10+' ? 'HDR10+' : undefined };
	}
	if (pq) return { label: hdr10, fromName: hdr10 === 'HDR10+' ? 'HDR10+' : undefined };
	if (video?.transfer === 'arib-std-b67') return { label: 'HLG' };
	if (video?.transfer) return { label: '' };
	return { label: tag, fromName: tag ? 'all' : undefined };
}

/** Lossless beats lossy, object audio (Atmos, DTS:X) beats channels, more channels beat fewer. */
const audioRank = (track: Track): number => {
	const name = audioCodec(track);
	const lossless = /^(TrueHD|DTS-HD MA|DTS:X|FLAC|PCM|ALAC)/.test(name);
	return (lossless ? 4 : 0) + (/Atmos|DTS:X/.test(name) ? 2 : 0) + (track.channels ?? 0) / 100;
};
/**
 * The best track a copy carries, what tells copies apart; the first of equals, so the default one when it is
 * first. A Russian release's default dub beside the English TrueHD Atmos would hide what it holds; the details
 * view says which track is the default. Commentaries are never it.
 */
export const bestAudio = (tracks: readonly Track[]): Track | undefined =>
	tracks.filter((track) => !track.commentary).reduce<Track | undefined>((best, track) => (!best || audioRank(track) > audioRank(best) ? track : best), undefined) ?? tracks[0];

/**
 * A copy row's two lines: the picture ("4K · DV P8.1 + HDR10 · HEVC 10-bit") and the sound and subtitles
 * ("TrueHD Atmos 7.1 · EN, JA · Subs EN, ES +3"). `name` is the release's, for what only it says.
 */
export function copyFacts(probe: FileProbe, name: string): { picture: string[]; sound: string[] } {
	const video = probe.video;
	const resolution = video ? resolutionLabel(video) : '';
	// 4K is mostly HDR: one the probe says is SDR says so (Flow's 4K SDR remux).
	const range = video ? dynamicRange(video, name).label || (video.transfer && resolution === '4K' ? 'SDR' : '') : '';
	const picture = video ? [resolution, range, `${VIDEO[video.codec] ?? video.codec.toUpperCase()}${video.bitDepth && video.bitDepth >= 10 ? ` ${video.bitDepth}-bit` : ''}`] : [];
	const main = bestAudio(probe.audio);
	const sound = [main ? [audioCodec(main), channelLabel(main)].filter(Boolean).join(' ') : '', languageList(probe.audio)];
	const subs = languageList(probe.subs);
	if (subs) sound.push(`Subs ${subs}`);
	else if (probe.subs.length) sound.push(`Subs ×${probe.subs.length}`);
	return { picture: picture.filter(Boolean), sound: sound.filter(Boolean) };
}

const duration = (seconds: number): string => {
	const minutes = Math.round(seconds / 60);
	return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
};
const rate = (bits: number): string => (bits >= 1e6 ? `${(bits / 1e6).toFixed(1)} Mb/s` : `${Math.round(bits / 1e3)} kb/s`);
const CONTAINERS: [RegExp, string][] = [[/matroska/, 'MKV'], [/mp4|mov/, 'MP4'], [/avi/, 'AVI'], [/mpegts/, 'MPEG-TS'], [/webm/, 'WebM']];
const flags = (track: Track): string[] =>
	[track.default && 'Default', track.forced && 'Forced', track.sdh && 'SDH', track.commentary && 'Commentary'].filter((value): value is string => Boolean(value));

export interface DetailSection {
	title: string;
	rows: { text: string; note?: string }[];
}

/** Everything the details view lists: the file, the picture, every audio and subtitle track. */
export function copyDetails(probe: FileProbe, name: string): DetailSection[] {
	const sections: DetailSection[] = [];
	const container = CONTAINERS.find(([pattern]) => pattern.test(probe.container ?? ''))?.[1];
	sections.push({
		title: 'File',
		rows: [
			{ text: probe.path.split('/').filter(Boolean).pop() ?? probe.path },
			{ text: [formatBytes(probe.bytes), probe.duration ? duration(probe.duration) : '', container ?? '', probe.bitrate ? rate(probe.bitrate) : ''].filter(Boolean).join(' · ') },
		],
	});
	const video = probe.video;
	if (video) {
		const range = dynamicRange(video, name);
		const dv = video.dv;
		const rangeText = dv
			? `Dolby Vision profile ${dv.profile}${dv.compat ? `.${dv.compat}` : ''}${range.label.includes(' + ') ? `, ${range.label.split(' + ')[1]} for other screens` : ', Dolby Vision screens only'}`
			: range.label || (video.transfer ? 'SDR' : '');
		sections.push({
			title: 'Video',
			rows: [
				{ text: [`${VIDEO[video.codec] ?? video.codec.toUpperCase()}${video.profile && !/^\d+$/.test(video.profile) ? ` ${video.profile}` : ''}`, video.width ? `${video.width}×${video.height}` : '', video.fps ? `${video.fps} fps` : '', video.bitDepth ? `${video.bitDepth}-bit` : ''].filter(Boolean).join(' · ') },
				...(rangeText ? [{ text: rangeText, note: range.fromName === 'all' ? 'from the release name' : range.fromName ? 'HDR10+ from the release name' : undefined }] : []),
				...(video.bitrate ? [{ text: rate(video.bitrate) }] : []),
			],
		});
	}
	if (probe.audio.length) {
		sections.push({
			title: `Audio (${probe.audio.length})`,
			rows: probe.audio.map((track) => ({ text: [languageName(track.language), [audioCodec(track), channelLabel(track)].filter(Boolean).join(' '), ...flags(track)].join(' · '), note: track.title })),
		});
	}
	if (probe.subs.length) {
		sections.push({
			title: `Subtitles (${probe.subs.length})`,
			rows: probe.subs.map((track) => ({ text: [languageName(track.language), subtitleCodec(track.codec), ...flags(track)].join(' · '), note: track.title })),
		});
	}
	return sections;
}

// --- asking DMM ---------------------------------------------------------------------------------------------

/** The route's batch cap; its limit is 10 calls a minute an address. */
export const PROBE_BATCH = 100;
export const INFO_HASH = /^[a-f0-9]{40}$/;

const defaultPost: Post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/**
 * DMM's stored probes for these releases (lower-case info hashes), batch by batch: `onAnswer` gets each batch's
 * hashes with their files, an empty list for none stored. A refused batch (the rate limit, an error) ends the
 * run unanswered: the page asks again next time it opens. A refused login throws LoginRefused.
 */
export async function askProbes(hashes: readonly string[], identity: SyncIdentity, onAnswer: (answers: Map<string, FileProbe[]>) => void, post: Post = defaultPost): Promise<void> {
	for (let at = 0; at < hashes.length; at += PROBE_BATCH) {
		const batch = hashes.slice(at, at + PROBE_BATCH);
		const response = await post(`${DMM_ORIGIN}/api/library/mediainfo`, { hashes: batch, identity });
		if (response.status === 401 || response.status === 403) throw new LoginRefused(`DMM refused media info (${response.status}).`);
		if (!response.ok) return;
		const body = (await response.json()) as MediaInfoAnswer;
		onAnswer(new Map(batch.map((hash) => [hash, releaseProbes(body.releases?.[hash])])));
	}
}
