package expo.modules.displaymode

import kotlin.math.abs
import kotlin.math.roundToInt

private val STANDARD_RATES = floatArrayOf(24000f / 1001, 24f, 25f, 30000f / 1001, 30f, 48000f / 1001, 48f, 50f, 60000f / 1001, 60f, 100f, 120000f / 1001, 120f)

/** The standard frame rate [fps] was measured as (23.976, 25, 29.97, 50, …), or null if it's none of them. */
internal fun snapFrameRate(fps: Float): Float? {
  val nearest = STANDARD_RATES.minByOrNull { abs(it - fps) } ?: return null
  return if (abs(nearest - fps) <= nearest * 0.005f) nearest else null
}

/**
 * Frame rate from the presentation times (µs) of consecutive frames. Drops, seeks and timestamp jumps
 * fall away from the median interval; the intervals near it are averaged, which tells 25 from 24.975
 * and 23.976 from 24 even though timestamps are rounded to whole microseconds.
 */
internal fun estimateFrameRate(times: LongArray): Float? {
  val deltas = (1 until times.size).map { times[it] - times[it - 1] }.filter { it in 2_000..200_000 }.sorted()
  if (deltas.size < times.size / 2) return null
  val median = deltas[deltas.size / 2]
  val near = deltas.filter { abs(it - median) <= median / 20 }
  return snapFrameRate(1_000_000f * near.size / near.sum())
}

private fun fits(refreshRate: Float, fps: Float, tolerance: Float): Boolean {
  val k = (refreshRate / fps).roundToInt()
  return k >= 1 && abs(refreshRate - k * fps) <= refreshRate * tolerance
}

/**
 * The refresh rate to show [fps] at, from the [rates] the display offers at its resolution, or null if
 * none fits. Keeps [current] when it already works (60 Hz for 30/60 fps, and 59.94 fps is close enough
 * to 60) since every switch blanks the screen for a moment. Otherwise prefers an exact multiple, and the
 * highest rate up to 60 Hz: 50 Hz rather than 25 Hz for 25 fps, so menus stay smooth.
 */
internal fun pickRefreshRate(rates: List<Float>, current: Float, fps: Float): Float? {
  if (fits(current, fps, 0.002f)) return current
  for (tolerance in floatArrayOf(0.0005f, 0.002f)) {
    val candidates = rates.filter { fits(it, fps, tolerance) }
    if (candidates.isNotEmpty()) return candidates.filter { it <= 61f }.maxOrNull() ?: candidates.minOrNull()
  }
  return null
}
