package expo.modules.displaymode

import android.app.Activity
import android.media.MediaFormat
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Display
import android.view.View
import android.view.ViewGroup
import androidx.annotation.OptIn
import androidx.media3.common.Format
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.video.VideoFrameMetadataListener
import androidx.media3.ui.PlayerView
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private const val TAG = "NovaDisplayMode"

/**
 * Frame-rate matching for Android TV / Fire TV. European TV is 25/50 fps and films are 23.976/24 fps;
 * on a 60 Hz output some frames stay on screen longer than others, which shows as judder in pans and
 * scrolling tickers. This measures the frame rate of the video on screen and asks the display for a
 * refresh rate that's a whole multiple of it (50 Hz for 25/50 fps), keeping the resolution.
 *
 * Fire TV only honours the request with Settings → Display & Sounds → Display → Match original frame
 * rate turned on.
 */
@OptIn(UnstableApi::class)
class DisplayModeModule : Module() {
  private val main = Handler(Looper.getMainLooper())
  private var probe: FrameRateProbe? = null

  override fun definition() = ModuleDefinition {
    Name("DisplayMode")

    // Resolves { fps, refreshRate, switched }, or null when there's no video or its rate can't be told
    AsyncFunction("matchVideo") { promise: Promise ->
      val activity = appContext.currentActivity
      val player = activity?.let { findPlayer(it.window.decorView) }
      if (activity == null || player == null) {
        promise.resolve(null)
        return@AsyncFunction
      }
      probe?.cancel()
      probe = FrameRateProbe(player, main) { fps ->
        probe = null
        promise.resolve(fps?.let { applyFrameRate(activity, it) })
      }.also { it.start() }
    }.runOnQueue(Queues.MAIN)

    // Back to the display's own mode (the TV's default refresh rate)
    AsyncFunction("reset") {
      probe?.cancel()
      appContext.currentActivity?.let { setPreferredMode(it, 0) }
    }.runOnQueue(Queues.MAIN)

    // Refresh rates the display offers at its current resolution, e.g. [50, 60]
    Function("refreshRates") {
      val display = appContext.currentActivity?.let { displayOf(it) } ?: return@Function emptyList<Double>()
      sameSize(display).map { it.refreshRate.toDouble() }.distinct().sorted()
    }

    OnDestroy { main.post { probe?.cancel() } }
  }

  private fun applyFrameRate(activity: Activity, fps: Float): Map<String, Any> {
    val display = displayOf(activity) ?: return mapOf("fps" to fps, "refreshRate" to 0, "switched" to false)
    val current = display.mode
    val modes = sameSize(display)
    val rate = pickRefreshRate(modes.map { it.refreshRate }, current.refreshRate, fps)
    val best = if (rate == null || rate == current.refreshRate) current else modes.first { it.refreshRate == rate }
    // Already right (possibly from an earlier switch): leave the preference alone
    val switched = best.modeId != current.modeId
    if (switched) setPreferredMode(activity, best.modeId)
    Log.i(TAG, "video ${"%.3f".format(fps)} fps, display ${current.refreshRate} Hz → ${best.refreshRate} Hz")
    return mapOf("fps" to fps, "refreshRate" to best.refreshRate, "switched" to switched)
  }
}

private fun displayOf(activity: Activity): Display? =
  if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) activity.display else @Suppress("DEPRECATION") activity.windowManager.defaultDisplay

private fun sameSize(display: Display): List<Display.Mode> {
  val current = display.mode
  return display.supportedModes.filter { it.physicalWidth == current.physicalWidth && it.physicalHeight == current.physicalHeight }
}

private fun setPreferredMode(activity: Activity, modeId: Int) {
  val window = activity.window
  val attrs = window.attributes
  if (attrs.preferredDisplayModeId == modeId) return
  attrs.preferredDisplayModeId = modeId
  window.attributes = attrs
}

/** expo-video's view is a Media3 PlayerView; its player is the ExoPlayer that plays the stream. */
@OptIn(UnstableApi::class)
private fun findPlayer(view: View): ExoPlayer? {
  if (view is PlayerView) {
    val player = view.player
    if (player is ExoPlayer && view.isShown) return player
  }
  if (view is ViewGroup) {
    for (i in 0 until view.childCount) findPlayer(view.getChildAt(i))?.let { return it }
  }
  return null
}

/**
 * Reads the frame rate from the stream when the container declares it (MP4, MKV, HLS FRAME-RATE),
 * otherwise from the timestamps of the frames being shown. MPEG-TS, what live IPTV uses, doesn't
 * declare one.
 */
@OptIn(UnstableApi::class)
private class FrameRateProbe(
  private val player: ExoPlayer,
  private val main: Handler,
  private val done: (Float?) -> Unit,
) : VideoFrameMetadataListener {
  private val times = LongArray(SAMPLES)
  @Volatile private var count = 0
  private var finished = false
  private val timeout = Runnable { finish(null) }

  fun start() {
    player.setVideoFrameMetadataListener(this)
    main.postDelayed(timeout, 8000)
  }

  fun cancel() = finish(null)

  // Playback thread
  override fun onVideoFrameAboutToBeRendered(presentationTimeUs: Long, releaseTimeNs: Long, format: Format, mediaFormat: MediaFormat?) {
    if (format.frameRate > 0) {
      val declared = snapFrameRate(format.frameRate)
      main.post { finish(declared) }
      return
    }
    val n = count
    if (n >= SAMPLES) return
    times[n] = presentationTimeUs
    count = n + 1
    if (n + 1 == SAMPLES) main.post { finish(estimateFrameRate(times)) }
  }

  // Main thread (the player's application thread)
  private fun finish(fps: Float?) {
    if (finished) return
    finished = true
    main.removeCallbacks(timeout)
    player.clearVideoFrameMetadataListener(this)
    done(fps)
  }

  companion object {
    const val SAMPLES = 90
  }
}
