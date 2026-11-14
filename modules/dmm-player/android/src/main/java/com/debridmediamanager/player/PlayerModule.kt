package com.debridmediamanager.player

import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** The built-in player's view on Android (see VideoView); src/video.android.tsx gives it @lunarr/vlc-player's shape. */
@UnstableApi
class PlayerModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("DmmPlayer")

    View(VideoView::class) {
      Events("onProgress", "onBuffer", "onPlaying", "onPaused", "onEnd", "onTracks", "onError")

      Prop("source") { view: VideoView, source: Map<String, Any?> -> view.setSource(source) }
      Prop("rate") { view: VideoView, rate: Double -> view.setRate(rate) }
      Prop("pauseAt") { view: VideoView, at: Double -> view.setPauseAt(at) }
      Prop("resizeMode") { view: VideoView, mode: String? -> view.setResizeMode(mode) }

      OnViewDestroys { view: VideoView -> view.release() }

      // ExoPlayer is used from the thread that made it. Not Fabric commands: these still run in picture in picture.
      AsyncFunction("play") { view: VideoView -> view.play() }.runOnQueue(Queues.MAIN)
      AsyncFunction("pause") { view: VideoView -> view.pause() }.runOnQueue(Queues.MAIN)
      AsyncFunction("seek") { view: VideoView, seconds: Double -> view.seek(seconds) }.runOnQueue(Queues.MAIN)
      AsyncFunction("getTracks") { view: VideoView -> view.emitTracks() }.runOnQueue(Queues.MAIN)
      AsyncFunction("selectAudioTrack") { view: VideoView, id: Int -> view.selectTrack(C.TRACK_TYPE_AUDIO, id) }.runOnQueue(Queues.MAIN)
      AsyncFunction("selectSubtitleTrack") { view: VideoView, id: Int -> view.selectTrack(C.TRACK_TYPE_TEXT, id) }.runOnQueue(Queues.MAIN)
      AsyncFunction("setSubtitleFile") { view: VideoView, url: String -> view.addSubtitleFile(url) }.runOnQueue(Queues.MAIN)
      AsyncFunction("setAudioDelay") { view: VideoView, micros: Double -> view.setAudioDelay(micros) }.runOnQueue(Queues.MAIN)
      AsyncFunction("setSubtitleDelay") { view: VideoView, micros: Double -> view.setSubtitleDelay(micros) }.runOnQueue(Queues.MAIN)
      AsyncFunction("enterPictureInPicture") { view: VideoView -> view.enterPictureInPicture() }.runOnQueue(Queues.MAIN)
    }
  }
}
