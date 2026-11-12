// Plays each file given with libVLC into memory (the amem output) and says whether sound came
// out, with the audio tracks libVLC lists and the one it selected. Built against a VLCKit
// framework and run in a simulator by vlckit/check.sh; exits with the number of silent files.
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

// The few libVLC 3 calls used; VLCKit exports them but ships no C headers.
typedef struct libvlc_instance_t libvlc_instance_t;
typedef struct libvlc_media_t libvlc_media_t;
typedef struct libvlc_media_player_t libvlc_media_player_t;
typedef struct track { int id; char *name; struct track *next; } track;
typedef void (*play_cb)(void *, const void *, unsigned, int64_t);
typedef void (*log_cb)(void *, int, const void *, const char *, va_list);
libvlc_instance_t *libvlc_new(int, const char *const *);
void libvlc_log_set(libvlc_instance_t *, log_cb, void *);
libvlc_media_t *libvlc_media_new_path(libvlc_instance_t *, const char *);
libvlc_media_player_t *libvlc_media_player_new_from_media(libvlc_media_t *);
void libvlc_audio_set_callbacks(libvlc_media_player_t *, play_cb, void *, void *, void *, void *, void *);
void libvlc_audio_set_format(libvlc_media_player_t *, const char *, unsigned, unsigned);
int libvlc_media_player_play(libvlc_media_player_t *);
int libvlc_media_player_get_state(libvlc_media_player_t *);
track *libvlc_audio_get_track_description(libvlc_media_player_t *);
int libvlc_audio_get_track(libvlc_media_player_t *);
void libvlc_track_description_list_release(track *);
void libvlc_media_player_release(libvlc_media_player_t *);
void libvlc_media_release(libvlc_media_t *);

enum { PLAYING = 3, STOPPED = 5 };
static long frames;
static int peak;

static void play(void *data, const void *samples, unsigned count, int64_t pts) {
	const int16_t *pcm = samples;
	for (unsigned i = 0; i < count * 2; i++) peak = abs(pcm[i]) > peak ? abs(pcm[i]) : peak;
	frames += count;
}

// libVLC's own word on a missing decoder ("Codec `trhd' (TrueHD Audio) is not supported").
static void log_codec_errors(void *data, int level, const void *ctx, const char *fmt, va_list args) {
	char line[512];
	vsnprintf(line, sizeof line, fmt, args);
	if (level >= 4 && strstr(line, "odec")) printf("  libvlc: %s\n", line);
}

int main(int argc, char **argv) {
	const char *options[] = {"--vout=dummy"};
	libvlc_instance_t *vlc = libvlc_new(1, options);
	libvlc_log_set(vlc, log_codec_errors, NULL);
	int silent = 0;
	for (int n = 1; n < argc; n++) {
		frames = peak = 0;
		libvlc_media_t *media = libvlc_media_new_path(vlc, argv[n]);
		libvlc_media_player_t *player = libvlc_media_player_new_from_media(media);
		libvlc_audio_set_callbacks(player, play, NULL, NULL, NULL, NULL, NULL);
		libvlc_audio_set_format(player, "S16N", 48000, 2);
		libvlc_media_player_play(player);
		printf("%s\n", argv[n]);
		int listed = 0;
		for (int waited = 0; waited < 300 && libvlc_media_player_get_state(player) < STOPPED; waited++) {
			if (!listed && libvlc_media_player_get_state(player) == PLAYING) {
				listed = 1;
				track *tracks = libvlc_audio_get_track_description(player);
				printf("  audio tracks:");
				for (track *t = tracks; t; t = t->next) printf(" [%d] %s;", t->id, t->name);
				printf(" selected %d\n", libvlc_audio_get_track(player));
				libvlc_track_description_list_release(tracks);
			}
			usleep(50000);
		}
		// A decoded tone or speech peaks in the thousands; no decoder means no samples at all.
		int sound = peak >= 64;
		printf("  %ld frames, peak %d: %s\n", frames, peak, sound ? "SOUND" : "SILENT");
		silent += !sound;
		libvlc_media_player_release(player);
		libvlc_media_release(media);
	}
	return silent;
}
