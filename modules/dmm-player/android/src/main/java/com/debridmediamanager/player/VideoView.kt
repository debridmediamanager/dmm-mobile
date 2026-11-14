package com.debridmediamanager.player

import android.app.Activity
import android.app.ActivityManager
import android.app.Application
import android.app.PendingIntent
import android.app.PictureInPictureParams
import android.app.RemoteAction
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Color
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.Rational
import android.view.Gravity
import android.view.SurfaceView
import android.widget.FrameLayout
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.VideoSize
import androidx.media3.common.text.CueGroup
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.TransferListener
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlaybackException
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.RenderersFactory
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy
import androidx.media3.exoplayer.upstream.LoadErrorHandlingPolicy
import androidx.media3.exoplayer.trackselection.DefaultTrackSelector
import androidx.media3.extractor.DefaultExtractorsFactory
import androidx.media3.extractor.ExtractorsFactory
import androidx.media3.extractor.metadata.Chapter
import androidx.media3.extractor.mkv.MatroskaExtractor
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.CaptionStyleCompat
import androidx.media3.ui.SubtitleView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import io.github.peerless2012.ass.media.AssHandler
import io.github.peerless2012.ass.media.factory.AssRenderersFactory
import io.github.peerless2012.ass.media.parser.AssSubtitleParserFactory
import io.github.peerless2012.ass.media.render.AssRenderer
import io.github.peerless2012.ass.media.type.AssRenderType
import io.github.peerless2012.ass.media.widget.AssSubtitleView
import java.util.Locale
import java.util.concurrent.atomic.AtomicLong

/**
 * The built-in player on Android: Media3 (ExoPlayer) on a SurfaceView, so HDR and Dolby Vision reach the display,
 * with FFmpeg's audio decoders and libass for ASS subtitles. Its props, events and functions are the ones
 * src/screens/PlayerScreen.tsx uses of @lunarr/vlc-player (iPhone, iPad and Apple TV keep libVLC), through src/video.android.tsx.
 */
@UnstableApi
class VideoView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout = true

  private val onProgress by EventDispatcher()
  private val onBuffer by EventDispatcher()
  private val onPlaying by EventDispatcher()
  private val onPaused by EventDispatcher()
  private val onEnd by EventDispatcher()
  private val onTracks by EventDispatcher()
  private val onError by EventDispatcher()

  private val frame = AspectRatioFrameLayout(context)
  private val surface = SurfaceView(context)
  private val subtitles = SubtitleView(context)
  private val ass = AssHandler(AssRenderType.OVERLAY_OPEN_GL)
  private val audioDelayUs = AtomicLong(0)
  private val subtitleDelayUs = AtomicLong(0)
  private val main = Handler(Looper.getMainLooper())
  private val player: ExoPlayer

  private var uri: String? = null
  private var resizeMode = "contain"
  private var pauseAt = 0L
  private var resumeOnReturn = false
  private var released = false
  /** Track ids handed to JS, per type: their place in this list. */
  private var listed = mapOf<Int, List<Pair<Tracks.Group, Int>>>()
  /** A subtitle file added while playing, selected once its track shows up. */
  private var addedSubtitle: String? = null
  private var unplayableSent = false
  /** Played once: from then on a dropped connection is retried, not an error (read on the loading thread). */
  @Volatile private var ready = false

  private fun buildPlayer(): ExoPlayer {
    val http = DefaultHttpDataSource.Factory()
      .setUserAgent("DMM Mobile")
      .setAllowCrossProtocolRedirects(true)
      .setConnectTimeoutMs(15_000)
      .setReadTimeoutMs(20_000)
      .setTransferListener(byteCounter)
    val parsers = AssSubtitleParserFactory(ass)
    val defaults = DefaultExtractorsFactory()
    val extractors = ExtractorsFactory {
      defaults.createExtractors().map { if (it is MatroskaExtractor) MkvFixes(ZlibMatroskaExtractor(parsers, ass)) else it }.toTypedArray()
    }
    val media = DefaultMediaSourceFactory(DefaultDataSource.Factory(context, http), extractors)
      .setSubtitleParserFactory(parsers)
      // Once it plays, a dropped connection is retried for as long as it takes (Media3 gives up after 3 tries, buffer left
      // or not: 34 s into a blocked connection on the Pixel): the screen's 30 s stall watchdog decides when it stopped.
      // A file that never opened fails after Media3's 3 tries, and 4xx answers at once, as before.
      .setLoadErrorHandlingPolicy(object : DefaultLoadErrorHandlingPolicy(Int.MAX_VALUE) {
        override fun getRetryDelayMsFor(info: LoadErrorHandlingPolicy.LoadErrorInfo): Long =
          if (!ready && info.errorCount > DefaultLoadErrorHandlingPolicy.DEFAULT_MIN_LOADABLE_RETRY_COUNT) C.TIME_UNSET else super.getRetryDelayMsFor(info)
      })

    // Platform decoders first (and passthrough to an AV receiver when it takes the format), FFmpeg's for what they lack.
    val base = object : DefaultRenderersFactory(context) {
      override fun buildAudioSink(context: Context, enableFloatOutput: Boolean, enableAudioOutputPlaybackParams: Boolean) =
        DelayedAudioSink(super.buildAudioSink(context, enableFloatOutput, enableAudioOutputPlaybackParams)!!, audioDelayUs)
    }.setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_ON).setEnableDecoderFallback(true)
    val withAss = AssRenderersFactory(ass, base)
    val renderers = RenderersFactory { handler, video, audio, text, metadata ->
      withAss.createRenderers(handler, video, audio, text, metadata)
        .map { if (it.trackType == C.TRACK_TYPE_TEXT || it is AssRenderer) DelayedSubtitles(it, subtitleDelayUs) else it }
        .toTypedArray()
    }

    // Media3 buffers up to ~137 MB of a 4K remux in the Java heap; a Fire TV Cube's app heap is 192 MB, and React Native
    // holds ~45 MB of it (178 MB used playing Birds of Prey there, 2026-11-14). A quarter of the heap, 32 MB at least.
    val heapMb = (context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager).memoryClass
    val load = DefaultLoadControl.Builder()
      .setTargetBufferBytes((heapMb / 4).coerceIn(32, 137) * 1024 * 1024)
      .setPrioritizeTimeOverSizeThresholds(false)
      .build()

    return ExoPlayer.Builder(context)
      .setLoadControl(load)
      .setRenderersFactory(renderers)
      .setMediaSourceFactory(media)
      .setTrackSelector(DefaultTrackSelector(context))
      .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build(), true)
      .setHandleAudioBecomingNoisy(true)
      .build()
  }

  // ---- Props ----

  fun setSource(source: Map<String, Any?>) {
    val next = source["uri"] as? String ?: return
    if (next == uri) return
    uri = next
    unplayableSent = false
    player.setMediaItem(MediaItem.fromUri(next), ((source["startMs"] as? Number)?.toLong() ?: 0L))
    player.prepare()
    player.playWhenReady = true
  }

  fun setRate(rate: Double) {
    if (rate > 0) player.setPlaybackSpeed(rate.toFloat())
  }

  fun setPauseAt(at: Double) {
    pauseAt = at.toLong()
  }

  fun setResizeMode(mode: String?) {
    resizeMode = mode ?: "contain"
    layoutPicture()
  }

  // ---- Functions ----

  fun play() {
    // A time that passed while paused is spent.
    if (pauseAt in 1..System.currentTimeMillis()) pauseAt = 0
    if (player.playbackState == Player.STATE_IDLE) player.prepare()
    player.play()
  }

  fun pause() = player.pause()

  fun seek(seconds: Double) = player.seekTo((seconds * 1000).toLong())

  fun setAudioDelay(micros: Double) = audioDelayUs.set(micros.toLong())

  fun setSubtitleDelay(micros: Double) = subtitleDelayUs.set(micros.toLong())

  fun selectTrack(type: Int, id: Int) {
    val params = player.trackSelectionParameters.buildUpon()
    val track = listed[type]?.getOrNull(id)
    if (track == null) params.setTrackTypeDisabled(type, true)
    else params.setTrackTypeDisabled(type, false).setOverrideForType(TrackSelectionOverride(track.first.mediaTrackGroup, track.second))
    player.trackSelectionParameters = params.build()
  }

  /** A subtitle file of the same release: the item is set again with it, from where it plays. */
  fun addSubtitleFile(url: String) {
    val item = player.currentMediaItem ?: return
    val id = "file${item.localConfiguration?.subtitleConfigurations?.size ?: 0}"
    val path = Uri.parse(url).lastPathSegment?.lowercase(Locale.ROOT) ?: ""
    val mime = when {
      path.endsWith(".ass") || path.endsWith(".ssa") -> MimeTypes.TEXT_SSA
      path.endsWith(".vtt") -> MimeTypes.TEXT_VTT
      else -> MimeTypes.APPLICATION_SUBRIP
    }
    val config = MediaItem.SubtitleConfiguration.Builder(Uri.parse(url)).setMimeType(mime).setId(id).setLabel(Uri.parse(url).lastPathSegment).build()
    val configs = item.localConfiguration?.subtitleConfigurations.orEmpty() + config
    addedSubtitle = id
    player.setMediaItem(item.buildUpon().setSubtitleConfigurations(configs).build(), player.currentPosition)
    player.prepare()
  }

  fun emitTracks() {
    val tracks = player.currentTracks
    val byType = mutableMapOf<Int, MutableList<Pair<Tracks.Group, Int>>>()
    for (group in tracks.groups) for (i in 0 until group.length) byType.getOrPut(group.type) { mutableListOf() }.add(group to i)
    // Media3 lists tracks by the renderer that plays them (a platform decoder's first): in the file's order they match its
    // probe (the badges) and read as other players list them. A format's id is its track number; added files go last.
    byType.values.forEach { list -> list.sortBy { (group, i) -> group.getTrackFormat(i).id?.substringAfterLast(':')?.toIntOrNull() ?: Int.MAX_VALUE } }
    listed = byType
    val list = { type: Int ->
      byType[type].orEmpty().mapIndexed { id, (group, i) ->
        val format = group.getTrackFormat(i)
        mapOf(
          "id" to id,
          "language" to (format.language ?: ""),
          "label" to (format.label ?: ""),
          // Subtitles parsed while extracting are Media3's own cues; their source format is in codecs.
          "mime" to ((if (format.sampleMimeType == MimeTypes.APPLICATION_MEDIA3_CUES) format.codecs else format.sampleMimeType) ?: ""),
          "channels" to maxOf(0, format.channelCount),
          "forced" to (format.selectionFlags and C.SELECTION_FLAG_FORCED != 0),
          "supported" to group.isTrackSupported(i, true),
        )
      }
    }
    val selected = { type: Int -> byType[type].orEmpty().indexOfFirst { (group, i) -> group.isTrackSelected(i) } }
    val chapters = byType[C.TRACK_TYPE_VIDEO].orEmpty().firstNotNullOfOrNull { (group, i) -> group.getTrackFormat(i).metadata }
      ?.let { metadata -> (0 until metadata.length()).mapNotNull { metadata[it] as? Chapter }.filter { !it.isHidden && it.startTimeMs != C.TIME_UNSET } }
      .orEmpty().sortedBy { it.startTimeMs }
    onTracks(
      mapOf(
        "audio" to list(C.TRACK_TYPE_AUDIO),
        "audioIndex" to selected(C.TRACK_TYPE_AUDIO),
        "subtitle" to list(C.TRACK_TYPE_TEXT),
        "subtitleIndex" to selected(C.TRACK_TYPE_TEXT),
        "chapters" to chapters.map { mapOf("name" to (it.title?.value ?: ""), "time" to it.startTimeMs) },
      )
    )
  }

  // ---- Player events ----

  private val listener = object : Player.Listener {
    override fun onPlaybackStateChanged(state: Int) {
      debug { "state $state at ${player.currentPosition} ms, $bytes bytes read" }
      when (state) {
        Player.STATE_BUFFERING -> onBuffer(mapOf("isBuffering" to true))
        Player.STATE_READY -> {
          ready = true
          onBuffer(mapOf("isBuffering" to false))
        }
        Player.STATE_ENDED -> onEnd(mapOf())
      }
    }

    override fun onIsPlayingChanged(isPlaying: Boolean) {
      if (isPlaying) {
        onPlaying(mapOf())
        tick()
      }
      updatePictureInPicture()
    }

    override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
      if (!playWhenReady && reason != Player.PLAY_WHEN_READY_CHANGE_REASON_END_OF_MEDIA_ITEM) onPaused(mapOf())
    }

    override fun onRenderedFirstFrame() = debug { "first frame at ${player.currentPosition} ms, $bytes bytes read" }

    override fun onTracksChanged(tracks: Tracks) {
      debug {
        tracks.groups.joinToString("\n") { group ->
          (0 until group.length).joinToString("\n") { i ->
            group.getTrackFormat(i).let { "type ${group.type} ${it.language} ${it.sampleMimeType} ${it.codecs} ${it.channelCount}ch selected=${group.isTrackSelected(i)} support=${group.getTrackSupport(i)}" }
          }
        }
      }
      addedSubtitle?.let { id ->
        val group = tracks.groups.firstOrNull { it.type == C.TRACK_TYPE_TEXT && (0 until it.length).any { i -> it.getTrackFormat(i).id?.endsWith(id) == true } }
        if (group != null) {
          addedSubtitle = null
          player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
            .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false).setOverrideForType(TrackSelectionOverride(group.mediaTrackGroup, 0)).build()
        }
      }
      // A picture no decoder here takes (VC-1 or 10-bit H.264 on most phones) would play as sound over black.
      val video = tracks.groups.filter { it.type == C.TRACK_TYPE_VIDEO }
      if (video.isNotEmpty() && video.none { it.isSelected } && !unplayableSent) {
        unplayableSent = true
        player.pause()
        onError(mapOf("code" to "VIDEO_UNSUPPORTED", "detail" to (video[0].getTrackFormat(0).let { it.codecs ?: it.sampleMimeType } ?: ""), "kind" to "video"))
      }
      emitTracks()
    }

    override fun onPlayerError(error: PlaybackException) {
      // The format a decoder failed on, when one did: names the codec in the message.
      val format = (error as? ExoPlaybackException)?.takeIf { it.type == ExoPlaybackException.TYPE_RENDERER }?.rendererFormat
      onError(mapOf("code" to error.errorCodeName, "detail" to (format?.let { it.codecs ?: it.sampleMimeType } ?: ""), "kind" to (format?.sampleMimeType?.substringBefore('/') ?: "")))
    }

    override fun onVideoSizeChanged(videoSize: VideoSize) = layoutPicture()

    override fun onCues(cueGroup: CueGroup) = subtitles.setCues(cueGroup.cues)
  }

  /** Half-second clock while it plays: the position for the controls and resume points, and the sleep timer's pause. */
  private fun tick() {
    main.removeCallbacks(ticker)
    main.post(ticker)
  }

  private val ticker = object : Runnable {
    override fun run() {
      if (released || !player.playWhenReady) return
      if (pauseAt > 0 && System.currentTimeMillis() >= pauseAt) {
        pauseAt = 0
        player.pause()
        return
      }
      val duration = player.duration.takeIf { it != C.TIME_UNSET } ?: 0L
      onProgress(mapOf("currentTime" to player.currentPosition / 1000.0, "duration" to duration / 1000.0))
      main.postDelayed(this, 500)
    }
  }

  // ---- Picture size ----

  private fun layoutPicture() {
    val size = player.videoSize
    val width = (size.width * size.pixelWidthHeightRatio).toInt()
    if (size.width > 0 && size.height > 0) frame.setAspectRatio(width.toFloat() / size.height)
    // 'center': the picture at its own pixels, cropped by the screen when larger.
    val original = resizeMode == "center" && size.width > 0
    frame.layoutParams = FrameLayout.LayoutParams(if (original) width else FrameLayout.LayoutParams.MATCH_PARENT, if (original) size.height else FrameLayout.LayoutParams.MATCH_PARENT, Gravity.CENTER)
    frame.resizeMode = when (resizeMode) {
      "cover" -> AspectRatioFrameLayout.RESIZE_MODE_ZOOM
      "stretch", "center" -> AspectRatioFrameLayout.RESIZE_MODE_FILL
      else -> AspectRatioFrameLayout.RESIZE_MODE_FIT
    }
  }

  // ---- Lifecycle: the app's activity going to the background pauses, coming back resumes ----

  private fun hostResumed() {
    if (resumeOnReturn) {
      resumeOnReturn = false
      play()
    }
  }

  private fun hostPaused() {
    // Entering picture in picture pauses the activity: the video plays on in the small window.
    if (isInPictureInPicture()) return
    if (player.playWhenReady) {
      player.pause()
      resumeOnReturn = true
    }
  }

  fun release() {
    if (released) return
    released = true
    main.removeCallbacks(ticker)
    watchPictureInPicture(false)
    player.release()
  }

  // ---- Picture in picture (Android 8+), as patches/@lunarr+vlc-player+2.1.1.patch had it for libVLC ----

  private fun isInPictureInPicture(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && appContext.currentActivity?.isInPictureInPictureMode == true

  fun enterPictureInPicture() {
    val activity = appContext.currentActivity ?: return
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    try {
      activity.enterPictureInPictureMode(pictureInPictureParams())
    } catch (e: IllegalStateException) {
      // Picture in picture is switched off for the app, or the device has none.
      Log.w(TAG, "No picture in picture", e)
    }
  }

  private fun pictureInPictureParams(): PictureInPictureParams {
    val playing = player.playWhenReady
    val label = if (playing) "Pause" else "Play"
    val intent = PendingIntent.getBroadcast(context, 0, Intent(PIP_PLAY_PAUSE).setPackage(context.packageName), PendingIntent.FLAG_IMMUTABLE)
    val icon = Icon.createWithResource("android", if (playing) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play)
    val builder = PictureInPictureParams.Builder().setActions(listOf(RemoteAction(icon, label, label, intent)))
    val size = player.videoSize
    if (size.width > 0 && size.height > 0) {
      // Android refuses a window wider than 2.39:1 or taller than 1:2.39.
      val ratio = (size.width * size.pixelWidthHeightRatio / size.height).coerceIn(0.42f, 2.38f)
      builder.setAspectRatio(Rational((ratio * 1000).toInt(), 1000))
    }
    return builder.build()
  }

  /** The window's play/pause button follows the player. */
  private fun updatePictureInPicture() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || !isInPictureInPicture()) return
    try {
      appContext.currentActivity?.setPictureInPictureParams(pictureInPictureParams())
    } catch (e: IllegalStateException) {
      Log.w(TAG, "Picture in picture params", e)
    }
  }

  private val pictureInPictureButton = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      if (player.playWhenReady) pause() else play()
    }
  }

  private val activityStops = object : Application.ActivityLifecycleCallbacks {
    // Closing the picture-in-picture window stops the activity (entering it only pauses it): playback stops too.
    override fun onActivityStopped(activity: Activity) {
      if (activity === appContext.currentActivity && player.playWhenReady) pause()
    }
    override fun onActivityResumed(activity: Activity) {
      if (activity === appContext.currentActivity) hostResumed()
    }
    override fun onActivityPaused(activity: Activity) {
      if (activity === appContext.currentActivity) hostPaused()
    }
    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
    override fun onActivityStarted(activity: Activity) {}
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
    override fun onActivityDestroyed(activity: Activity) {}
  }

  private var watching = false

  private fun watchPictureInPicture(watch: Boolean) {
    if (watch == watching) return
    val application = context.applicationContext as Application
    if (watch) {
      val filter = IntentFilter(PIP_PLAY_PAUSE)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) context.registerReceiver(pictureInPictureButton, filter, Context.RECEIVER_NOT_EXPORTED)
      else context.registerReceiver(pictureInPictureButton, filter)
      application.registerActivityLifecycleCallbacks(activityStops)
    } else {
      context.unregisterReceiver(pictureInPictureButton)
      application.unregisterActivityLifecycleCallbacks(activityStops)
    }
    watching = watch
  }

  // ---- Bytes read, for measuring seeks: `adb shell setprop log.tag.DmmPlayer DEBUG` (positions only, never the link) ----

  @Volatile private var bytes = 0L
  private val byteCounter = object : TransferListener {
    override fun onTransferInitializing(source: DataSource, dataSpec: DataSpec, isNetwork: Boolean) {}
    override fun onTransferStart(source: DataSource, dataSpec: DataSpec, isNetwork: Boolean) = debug { "open at ${dataSpec.position}" }
    override fun onBytesTransferred(source: DataSource, dataSpec: DataSpec, isNetwork: Boolean, bytesTransferred: Int) {
      bytes += bytesTransferred
    }
    override fun onTransferEnd(source: DataSource, dataSpec: DataSpec, isNetwork: Boolean) = debug { "close from ${dataSpec.position}, $bytes bytes so far" }
  }

  // Last: it uses the listeners above.
  init {
    setBackgroundColor(Color.BLACK)
    val root = FrameLayout(context)
    addView(root, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    root.addView(frame, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT, Gravity.CENTER))
    frame.addView(surface, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    // Inside the picture's frame, as Media3's own PlayerView has them: ASS signs sit where the video puts them.
    frame.addView(subtitles, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    // White with a black edge, as VLC drew them; Media3's default is a black box.
    subtitles.setStyle(CaptionStyleCompat(Color.WHITE, Color.TRANSPARENT, Color.TRANSPARENT, CaptionStyleCompat.EDGE_TYPE_OUTLINE, Color.BLACK, null))
    subtitles.addView(AssSubtitleView(context, ass))

    player = buildPlayer()
    player.setVideoSurfaceView(surface)
    player.addListener(listener)
    ass.init(player)
    watchPictureInPicture(true)
  }

  /** Off unless `adb shell setprop log.tag.DmmPlayer DEBUG`: what plays and when, never the link. */
  private fun debug(message: () -> String) {
    if (Log.isLoggable(TAG, Log.DEBUG)) Log.d(TAG, message())
  }

  companion object {
    private const val TAG = "DmmPlayer"
    private const val PIP_PLAY_PAUSE = "com.debridmediamanager.player.PIP_PLAY_PAUSE"
  }
}
