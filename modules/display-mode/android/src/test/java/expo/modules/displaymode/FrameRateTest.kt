package expo.modules.displaymode

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class FrameRateTest {
  /** Presentation times of [n] frames at [fps], rounded to whole µs like ExoPlayer's (90 kHz TS clock). */
  private fun frames(fps: Double, n: Int = 90, start: Long = 1_000_000): LongArray =
    LongArray(n) { start + Math.round(it * 1_000_000.0 / fps) }

  @Test
  fun measuresBroadcastAndFilmRates() {
    assertEquals(25f, estimateFrameRate(frames(25.0))!!, 0.001f)
    assertEquals(50f, estimateFrameRate(frames(50.0))!!, 0.001f)
    assertEquals(30000f / 1001, estimateFrameRate(frames(30000.0 / 1001))!!, 0.001f)
    assertEquals(60000f / 1001, estimateFrameRate(frames(60000.0 / 1001))!!, 0.001f)
    assertEquals(24000f / 1001, estimateFrameRate(frames(24000.0 / 1001))!!, 0.001f)
    assertEquals(24f, estimateFrameRate(frames(24.0))!!, 0.001f)
  }

  @Test
  fun ignoresDroppedFramesAndJumps() {
    val t = frames(25.0).toMutableList()
    t.removeAt(40) // a dropped frame: one 80 ms gap
    t.removeAt(60)
    val jumped = t.mapIndexed { i, v -> if (i > 70) v + 5_000_000 else v } // timestamp discontinuity
    assertEquals(25f, estimateFrameRate(jumped.toLongArray())!!, 0.001f)
  }

  @Test
  fun rejectsUnusableTimestamps() {
    assertNull(estimateFrameRate(LongArray(90) { 1_000_000 })) // all the same
    assertNull(estimateFrameRate(frames(17.0))) // not a video standard
  }

  @Test
  fun keepsTheCurrentRateWhenItAlreadyFits() {
    assertEquals(60f, pickRefreshRate(listOf(50f, 60f), 60f, 30f))
    assertEquals(60f, pickRefreshRate(listOf(50f, 59.94f, 60f), 60f, 60000f / 1001))
    assertEquals(50f, pickRefreshRate(listOf(50f, 60f), 50f, 25f))
  }

  @Test
  fun switchesEuropeanTvTo50Hz() {
    assertEquals(50f, pickRefreshRate(listOf(24f, 25f, 50f, 60f), 60f, 25f))
    assertEquals(50f, pickRefreshRate(listOf(50f, 60f), 60f, 50f))
    assertEquals(25f, pickRefreshRate(listOf(25f, 60f), 60f, 25f))
  }

  @Test
  fun prefersExactFilmRates() {
    assertEquals(23.976f, pickRefreshRate(listOf(23.976f, 24f, 50f, 60f), 60f, 24000f / 1001)!!, 0.001f)
    assertEquals(24f, pickRefreshRate(listOf(23.976f, 24f, 50f, 60f), 60f, 24f))
    // no 23.976 Hz mode: 24 Hz is close enough (one repeated frame every 42 s)
    assertEquals(24f, pickRefreshRate(listOf(24f, 50f, 60f), 60f, 24000f / 1001))
  }

  @Test
  fun leavesTheDisplayAloneWhenNothingFits() {
    assertNull(pickRefreshRate(listOf(60f), 60f, 25f))
  }
}
