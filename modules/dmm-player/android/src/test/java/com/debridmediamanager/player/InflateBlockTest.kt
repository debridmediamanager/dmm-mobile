package com.debridmediamanager.player

import java.util.zip.Inflater
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class InflateBlockTest {
  // Blender's Sintel.2010.1080p.mkv (CC BY) remuxed with `mkvmerge --compression 2:zlib` (v103): the first block of its
  // zlib-compressed English subtitle track (track 4, 1:47.250), which Media3 showed as deflate bytes.
  private val block = "84048f0078da0bc9c82c5648ca494c4955c8482c56485448492cca5628482c2ed1030083a80956".chunked(2).map { it.toInt(16).toByte() }.toByteArray()

  @Test
  fun inflatesTheFrameAndKeepsTheHeader() {
    val out = inflateBlock(block, block.size, Inflater())!!
    assertArrayEquals(block.copyOf(4), out.copyOf(4))
    assertEquals("This blade has a dark past.", String(out, 4, out.size - 4))
  }

  @Test
  fun leavesLacedAndUncompressedBlocksAlone() {
    assertNull(inflateBlock(block.copyOf().also { it[3] = 0x02 }, block.size, Inflater()))
    val plain = block.copyOf(4) + "This blade has a dark past.".toByteArray()
    assertNull(inflateBlock(plain, plain.size, Inflater()))
  }
}
