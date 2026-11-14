import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'android', isTV: false }, Linking: {} }));
vi.mock('expo-secure-store', () => ({}));
vi.mock('expo-intent-launcher', () => ({}));

import { audioName, errorText, pictureName, playerTracks, startMs, subtitleName, type NativeTrack, type NativeTracks } from './androidPlayer';
import { chapterAt, chaptersOf, soundUnplayable } from './player';

const track = (fields: Partial<NativeTrack>): NativeTrack => ({ id: 0, language: '', label: '', mime: '', channels: 0, forced: false, supported: true, ...fields });

describe('Android track names', () => {
	it('names audio by its language, codec and channels, after the container name', () => {
		expect(audioName(track({ language: 'en', mime: 'audio/true-hd', channels: 8 }))).toBe('English · TrueHD 7.1');
		expect(audioName(track({ language: 'en', mime: 'audio/eac3-joc', channels: 6 }))).toBe('English · DD+ Atmos 5.1');
		expect(audioName(track({ language: 'ja', mime: 'audio/opus', channels: 2, label: 'Commentary' }))).toBe('Commentary · Japanese · Opus 2.0');
		expect(audioName(track({ language: 'und', mime: 'audio/vnd.dts.hd', channels: 6 }))).toBe('DTS-HD 5.1');
		expect(audioName(track({ id: 2, mime: '' }))).toBe('Track 3');
		// The Brothers Bloom's tracks (2026-11-14, Pixel 6): their names already say the language and codec.
		expect(audioName(track({ language: 'en', mime: 'audio/vnd.dts.hd', channels: 6, label: 'DTS-HD MA 5.1' }))).toBe('DTS-HD MA 5.1 · English');
		expect(subtitleName(track({ language: 'en', mime: 'application/pgs', label: 'English (SDH)' }))).toBe('English (SDH) · PGS');
		expect(subtitleName(track({ language: 'fr', mime: 'application/pgs', label: 'French-FORCED-PGS', forced: true }))).toBe('French-FORCED-PGS');
	});

	it('names subtitles by language, forced and format', () => {
		expect(subtitleName(track({ language: 'en', mime: 'application/pgs', forced: true }))).toBe('English · Forced · PGS');
		expect(subtitleName(track({ language: 'en', mime: 'text/x-ssa', label: 'Signs & Songs' }))).toBe('Signs & Songs · English · ASS');
		expect(subtitleName(track({ language: 'pt-BR', mime: 'application/x-subrip' }))).toBe('Portuguese · SRT');
	});
});

describe('Android tracks in the screen\'s shape', () => {
	const native: NativeTracks = {
		audio: [track({ id: 0, language: 'en', mime: 'audio/true-hd', channels: 8 }), track({ id: 1, language: 'en', mime: 'audio/ac3', channels: 6 })],
		audioIndex: 0,
		subtitle: [track({ id: 0, language: 'en', mime: 'application/pgs' })],
		subtitleIndex: -1,
		chapters: [{ name: 'Opening', time: 0 }, { name: '', time: 312_000 }],
	};

	it('drops a track name every track carries, such as the release name', () => {
		const release = 'Birds.of.Prey.2020.2160p.BluRay.REMUX.HEVC.DTS-HD.MA.TrueHD.7.1.Atmos-FGT';
		const tracks = playerTracks({ ...native, audio: native.audio.map((entry) => ({ ...entry, label: release })), subtitle: [track({ id: 0, language: 'en', mime: 'application/pgs', label: 'English-PGS' })] });
		expect(tracks.audio.map((entry) => entry.name)).toEqual(['', 'English · TrueHD 7.1', 'English · DD 5.1']);
		expect(tracks.subtitle[1].name).toBe('English-PGS');
	});

	it('lists "No sound" and "Off" first, as libVLC does, and keeps the ids Media3 selects by', () => {
		const tracks = playerTracks(native);
		expect(tracks.audio.map((entry) => entry.id)).toEqual([-1, 0, 1]);
		expect(tracks.subtitle.map((entry) => entry.id)).toEqual([-1, 0]);
		expect(tracks.audioIndex).toBe(0);
		expect(tracks.subtitleIndex).toBe(-1);
		expect(chapterAt(chaptersOf(tracks), 400_000)).toBe(1);
	});

	it('trips the sound safety net when no audio track could be selected', () => {
		expect(soundUnplayable(playerTracks(native))).toBe(false);
		expect(soundUnplayable(playerTracks({ ...native, audioIndex: -1 }))).toBe(true);
		expect(soundUnplayable(playerTracks({ ...native, audio: [], audioIndex: -1 }))).toBe(false);
	});
});

describe('Android start and errors', () => {
	it('starts where libVLC\'s :start-time option says', () => {
		expect(startMs([':start-time=3532.5'])).toBe(3_532_500);
		expect(startMs([])).toBe(0);
		expect(startMs(undefined)).toBe(0);
	});

	it('names pictures phones cannot decode', () => {
		expect(pictureName('avc1.6E0033')).toBe('10-bit H.264');
		expect(pictureName('avc1.640028')).toBe('H.264');
		expect(pictureName('video/wvc1')).toBe('VC-1');
		expect(pictureName('dvhe.05.06')).toBe('Dolby Vision profile 5');
		expect(pictureName('hvc1.2.4.L153.B0')).toBe('HEVC');
	});

	it('says why a file stopped', () => {
		expect(errorText({ code: 'VIDEO_UNSUPPORTED', detail: 'video/wvc1', kind: 'video' })).toBe('This device has no decoder for its picture (VC-1).');
		expect(errorText({ code: 'ERROR_CODE_DECODER_INIT_FAILED', detail: 'avc1.6E0033', kind: 'video' })).toBe('This device could not decode its picture (10-bit H.264).');
		expect(errorText({ code: 'ERROR_CODE_IO_NETWORK_CONNECTION_FAILED' })).toBe('The stream stopped arriving.');
		expect(errorText({ code: 'ERROR_CODE_IO_BAD_HTTP_STATUS' })).toBe('The provider stopped serving the file.');
		expect(errorText({ code: 'ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED' })).toBe('This file could not be read.');
		expect(errorText({})).toBe('This file could not be played here.');
	});
});
