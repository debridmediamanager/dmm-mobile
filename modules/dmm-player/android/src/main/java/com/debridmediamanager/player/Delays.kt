package com.debridmediamanager.player

import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.Renderer
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.ForwardingAudioSink
import java.util.concurrent.atomic.AtomicLong

/**
 * Audio and subtitle delay, which Media3 has no setting for (both as in Plezy's PlezyRenderersFactory,
 * https://github.com/edde746/plezy, GPL-3.0). Plus plays it later, as VLC's delays do.
 */

/** The audio clock, which the picture follows, runs `delayUs` ahead: the picture comes sooner, so the sound is later. */
@UnstableApi
internal class DelayedAudioSink(sink: AudioSink, private val delayUs: AtomicLong) : ForwardingAudioSink(sink) {
  override fun getCurrentPositionUs(sourceEnded: Boolean): Long {
    val position = super.getCurrentPositionUs(sourceEnded)
    return if (position == AudioSink.CURRENT_POSITION_NOT_SET) position else position + delayUs.get()
  }
}

/** Subtitles chosen for a clock `delayUs` behind. */
@UnstableApi
internal class DelayedSubtitles(private val renderer: Renderer, private val delayUs: AtomicLong) : Renderer by renderer {
  override fun render(positionUs: Long, elapsedRealtimeUs: Long) = renderer.render(positionUs - delayUs.get(), elapsedRealtimeUs)

  // Java default methods are not delegated by `by`.
  override fun getDurationToProgressUs(positionUs: Long, elapsedRealtimeUs: Long) = renderer.getDurationToProgressUs(positionUs - delayUs.get(), elapsedRealtimeUs)
  override fun setPlaybackSpeed(currentPlaybackSpeed: Float, targetPlaybackSpeed: Float) = renderer.setPlaybackSpeed(currentPlaybackSpeed, targetPlaybackSpeed)
  override fun enableMayRenderStartOfStream() = renderer.enableMayRenderStartOfStream()
  override fun release() = renderer.release()
}
