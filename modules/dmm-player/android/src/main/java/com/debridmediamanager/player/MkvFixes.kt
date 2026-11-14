package com.debridmediamanager.player

import androidx.media3.common.C
import androidx.media3.common.DataReader
import androidx.media3.common.Format
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.UnstableApi
import androidx.media3.extractor.DefaultExtractorInput
import androidx.media3.extractor.Extractor
import androidx.media3.extractor.ExtractorInput
import androidx.media3.extractor.ExtractorOutput
import androidx.media3.extractor.PositionHolder
import androidx.media3.extractor.SeekMap
import androidx.media3.extractor.SeekPoint
import androidx.media3.extractor.TrackAwareSeekMap
import androidx.media3.extractor.TrackOutput
import androidx.media3.extractor.text.SubtitleParser
import io.github.peerless2012.ass.media.AssHandler
import io.github.peerless2012.ass.media.extractor.AssMatroskaExtractor
import java.io.EOFException
import java.util.concurrent.CopyOnWriteArrayList
import java.util.zip.DataFormatException
import java.util.zip.Inflater

/**
 * What Media3's MatroskaExtractor gets wrong with real debrid files, fixed around it:
 *
 * - An MKV without Cues is unseekable to Media3: seeks then go to a byte position in proportion to the
 *   time, resynced to the next Cluster. One whose Tracks come after its Clusters has Cues Media3 parsed but
 *   cannot use (its seek track is not known yet): seeks go through the per-track cue lookups.
 *   Both adapted from Plezy's CuelessSeekExtractorWrapper (https://github.com/edde746/plezy, GPL-3.0,
 *   android/app/src/main/kotlin/com/edde746/plezy/exoplayer/CuelessSeekExtractorWrapper.kt).
 * - Dolby Vision profile 7 (Blu-ray remuxes) has no decoder on phones or TV boxes, and Media3 offers no
 *   fallback for it: its base layer is plain HDR10 HEVC, so it is announced as HEVC (as Plezy's and Kodi's
 *   "HEVC strip" path do). HEVC decoders skip the profile's own NAL units (types 62 and 63).
 */
@UnstableApi
class MkvFixes(private val delegate: Extractor) : Extractor {
  private var inputLength = C.LENGTH_UNSET.toLong()
  private var approximate = false
  private var resyncTimeUs = C.TIME_UNSET
  private var resync = false
  /** Track ids and types seen on the output, for [TrackCueSeekMap]. */
  private val tracks = CopyOnWriteArrayList<Pair<Int, Int>>()

  override fun sniff(input: ExtractorInput): Boolean = delegate.sniff(input)

  override fun init(output: ExtractorOutput) = delegate.init(Output(output))

  override fun read(input: ExtractorInput, seekPosition: PositionHolder): Int {
    if (inputLength == C.LENGTH_UNSET.toLong()) inputLength = input.length
    if (resync) {
      resync = false
      return seekToCluster(input, seekPosition)
    }
    return delegate.read(input, seekPosition)
  }

  override fun seek(position: Long, timeUs: Long) {
    if (approximate && position > 0) {
      resync = true
      resyncTimeUs = timeUs
    }
    delegate.seek(position, timeUs)
  }

  override fun release() = delegate.release()

  /** From an estimated byte position, on to the next Cluster element (ID 1F 43 B6 75); the start if none within 1 MB. */
  private fun seekToCluster(input: ExtractorInput, seekPosition: PositionHolder): Int {
    val buffer = ByteArray(SCAN_BYTES + 3)
    var carried = 0
    var scanned = 0L
    while (scanned < MAX_SCAN_BYTES) {
      val read = try {
        input.read(buffer, carried, SCAN_BYTES)
      } catch (_: Exception) {
        break
      }
      if (read == C.RESULT_END_OF_INPUT) break
      val end = carried + read
      for (i in 0..end - 4) {
        if (buffer[i] == CLUSTER[0] && buffer[i + 1] == CLUSTER[1] && buffer[i + 2] == CLUSTER[2] && buffer[i + 3] == CLUSTER[3]) {
          val at = input.position - end + i
          seekPosition.position = at
          delegate.seek(at, resyncTimeUs)
          return Extractor.RESULT_SEEK
        }
      }
      // An ID split across two reads.
      carried = minOf(3, end)
      System.arraycopy(buffer, end - carried, buffer, 0, carried)
      scanned += read
    }
    seekPosition.position = 0
    delegate.seek(0, 0)
    return Extractor.RESULT_SEEK
  }

  private inner class Output(private val output: ExtractorOutput) : ExtractorOutput by output {
    override fun track(id: Int, type: Int): TrackOutput {
      if (tracks.none { it.first == id }) tracks.add(id to type)
      val track = output.track(id, type)
      return if (type == C.TRACK_TYPE_VIDEO) Profile7AsHevc(track) else track
    }

    override fun seekMap(seekMap: SeekMap) {
      approximate = false
      when {
        seekMap is SeekMap.Unseekable && seekMap.durationUs != C.TIME_UNSET && seekMap.durationUs > 0 -> {
          approximate = true
          output.seekMap(ProportionalSeekMap(seekMap.durationUs))
        }
        !seekMap.isSeekable && seekMap is TrackAwareSeekMap -> output.seekMap(TrackCueSeekMap(seekMap))
        else -> output.seekMap(seekMap)
      }
    }
  }

  private inner class ProportionalSeekMap(private val durationUs: Long) : SeekMap {
    override fun isSeekable() = true
    override fun getDurationUs() = durationUs
    override fun getSeekPoints(timeUs: Long): SeekMap.SeekPoints {
      if (inputLength == C.LENGTH_UNSET.toLong()) return SeekMap.SeekPoints(SeekPoint(0, 0))
      val time = timeUs.coerceIn(0, durationUs)
      return SeekMap.SeekPoints(SeekPoint(time, (time.toDouble() / durationUs * inputLength).toLong().coerceIn(0, inputLength)))
    }
  }

  /** Seeks by the cues of the first track that has them: video, then audio, then any. */
  private inner class TrackCueSeekMap(private val cues: TrackAwareSeekMap) : SeekMap {
    override fun isSeekable() = cues.isSeekable || seekTrack() != null
    override fun getDurationUs() = cues.durationUs
    override fun getSeekPoints(timeUs: Long): SeekMap.SeekPoints {
      if (cues.isSeekable) return cues.getSeekPoints(timeUs)
      val track = seekTrack() ?: return cues.getSeekPoints(timeUs)
      return cues.getSeekPoints(timeUs, track)
    }

    private fun seekTrack(): Int? {
      val seekable = tracks.filter { cues.isSeekable(it.first) }
      return (seekable.firstOrNull { it.second == C.TRACK_TYPE_VIDEO } ?: seekable.firstOrNull { it.second == C.TRACK_TYPE_AUDIO } ?: seekable.firstOrNull())?.first
    }
  }

  companion object {
    private val CLUSTER = byteArrayOf(0x1F, 0x43, 0xB6.toByte(), 0x75)
    private const val SCAN_BYTES = 8192
    private const val MAX_SCAN_BYTES = 1024 * 1024
  }
}

/** A Dolby Vision profile 7 video track announced as the HDR10 HEVC its base layer is. */
@UnstableApi
private class Profile7AsHevc(private val track: TrackOutput) : TrackOutput by track {
  override fun format(format: Format) = track.format(if (isProfile7(format.codecs)) asHevc(format) else format)
}

internal fun isProfile7(codecs: String?): Boolean = codecs?.lowercase()?.let { it.startsWith("dvhe.07") || it.startsWith("dvh1.07") } == true

/** The DV configuration record is not Annex B parameter sets: an HEVC decoder must not get it. */
@UnstableApi
internal fun asHevc(format: Format): Format = format.buildUpon()
  .setSampleMimeType(MimeTypes.VIDEO_H265)
  .setCodecs(null)
  .setInitializationData(format.initializationData.filter { it.size > 3 && it[0].toInt() == 0 && it[1].toInt() == 0 && (it[2].toInt() == 1 || (it[2].toInt() == 0 && it[3].toInt() == 1)) })
  .build()

/**
 * MKV tracks compressed with zlib, as older mkvmerge stored subtitles by default: Media3 throws on an explicit ContentCompAlgo 0
 * and passes the compressed bytes on when the element is left out (its default is zlib), so subtitles showed as garbage
 * (Sintel remuxed with `mkvmerge --compression 2:zlib`, Pixel 6, 2026-11-14). Each block of such a track is inflated before the
 * extractor reads it. Adapted from Plezy's ZlibMatroskaExtractor (https://github.com/edde746/plezy, GPL-3.0).
 */
@UnstableApi
class ZlibMatroskaExtractor(parsers: SubtitleParser.Factory, ass: AssHandler) : AssMatroskaExtractor(parsers, ass) {
  private var zlib = false
  private val zlibTracks = mutableSetOf<Int>()
  private val inflater = Inflater()
  private var block = ByteArray(0)

  override fun startMasterElement(id: Int, contentPosition: Long, contentSize: Long) {
    super.startMasterElement(id, contentPosition, contentSize)
    // ContentCompAlgo defaults to zlib: a ContentCompression without one is zlib.
    if (id == ID_CONTENT_COMPRESSION) zlib = true
  }

  override fun integerElement(id: Int, value: Long) {
    if (id == ID_CONTENT_COMPRESSION_ALGORITHM) {
      zlib = value == 0L
      // The extractor takes header stripping (3) only; for zlib it gets no stripped bytes (the settings are skipped below).
      if (zlib) return super.integerElement(id, 3)
    }
    super.integerElement(id, value)
  }

  override fun binaryElement(id: Int, contentSize: Int, input: ExtractorInput) {
    if (id == ID_CONTENT_COMPRESSION_SETTINGS && zlib) return input.skipFully(contentSize)
    if ((id == ID_SIMPLE_BLOCK || id == ID_BLOCK) && zlibTracks.isNotEmpty() && contentSize in 5..MAX_BLOCK && blockTrack(input) in zlibTracks) {
      val at = input.position
      if (block.size < contentSize) block = ByteArray(contentSize)
      input.readFully(block, 0, contentSize)
      val inflated = inflateBlock(block, contentSize, inflater)
      val data = inflated ?: block
      val length = inflated?.size ?: contentSize
      return super.binaryElement(id, length, DefaultExtractorInput(BytesReader(data, length), at, at + length))
    }
    super.binaryElement(id, contentSize, input)
  }

  override fun endMasterElement(id: Int) {
    if (id == ID_TRACK_ENTRY) {
      if (zlib) zlibTracks.add(getCurrentTrack(id).number)
      zlib = false
    }
    super.endMasterElement(id)
  }

  /** The block's track number (an EBML varint), peeked; null when it cannot be read. */
  private fun blockTrack(input: ExtractorInput): Int? = try {
    val first = ByteArray(1).also { input.peekFully(it, 0, 1) }[0].toInt() and 0xFF
    if (first == 0) null else {
      val length = Integer.numberOfLeadingZeros(first) - 23
      val rest = ByteArray(length - 1).also { if (length > 1) input.peekFully(it, 0, length - 1) }
      rest.fold((first and (0xFF ushr length)).toLong()) { value, byte -> (value shl 8) or (byte.toLong() and 0xFF) }.toInt()
    }
  } catch (_: EOFException) {
    null
  } finally {
    input.resetPeekPosition()
  }

  private class BytesReader(private val data: ByteArray, private val limit: Int) : DataReader {
    private var at = 0
    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
      if (at == limit) return C.RESULT_END_OF_INPUT
      val count = minOf(length, limit - at)
      System.arraycopy(data, at, buffer, offset, count)
      at += count
      return count
    }
  }

  companion object {
    private const val ID_TRACK_ENTRY = 0xAE
    private const val ID_CONTENT_COMPRESSION = 0x5034
    private const val ID_CONTENT_COMPRESSION_ALGORITHM = 0x4254
    private const val ID_CONTENT_COMPRESSION_SETTINGS = 0x4255
    private const val ID_SIMPLE_BLOCK = 0xA3
    private const val ID_BLOCK = 0xA1
    private const val MAX_BLOCK = 16 * 1024 * 1024
  }
}

/**
 * An unlaced Matroska block (track varint, 2-byte timecode, flags, frame) with its frame inflated; null to leave it as it is:
 * laced, not zlib, or inflating to more than 16 MB.
 */
internal fun inflateBlock(data: ByteArray, length: Int, inflater: Inflater): ByteArray? {
  val first = data[0].toInt() and 0xFF
  if (first == 0) return null
  val header = Integer.numberOfLeadingZeros(first) - 23 + 3
  if (length <= header || data[header - 1].toInt() and 0x06 != 0) return null
  inflater.reset()
  inflater.setInput(data, header, length - header)
  val out = java.io.ByteArrayOutputStream(maxOf(4096, (length - header) * 4))
  out.write(data, 0, header)
  val chunk = ByteArray(16 * 1024)
  try {
    while (!inflater.finished()) {
      val count = inflater.inflate(chunk)
      if (count == 0 && (inflater.needsInput() || inflater.needsDictionary())) return null
      out.write(chunk, 0, count)
      if (out.size() > 16 * 1024 * 1024) return null
    }
  } catch (_: DataFormatException) {
    return null
  }
  return out.toByteArray()
}
