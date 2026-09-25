package expo.modules.remotekeys

import android.app.UiModeManager
import android.content.Context
import android.content.res.Configuration
import android.os.Build
import android.view.KeyEvent
import android.view.ViewGroup
import android.widget.EditText
import android.widget.FrameLayout

/**
 * Wraps the React root view and sees every key event before the view hierarchy does.
 * The JS side owns focus (it renders its own focus rings), so D-pad keys are forwarded
 * to JS instead of moving Android's native focus between views.
 */
class KeyCaptureLayout(context: Context) : FrameLayout(context) {
  init {
    val uiMode = context.getSystemService(Context.UI_MODE_SERVICE) as? UiModeManager
    val isTv = uiMode?.currentModeType == Configuration.UI_MODE_TYPE_TELEVISION
    isFocusable = true
    isFocusableInTouchMode = isTv
    descendantFocusability = ViewGroup.FOCUS_BEFORE_DESCENDANTS
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) defaultFocusHighlightEnabled = false
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    post { if (!hasFocus()) requestFocus() }
  }

  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    val focused = findFocus()
    if (focused is EditText) {
      val vertical = event.keyCode == KeyEvent.KEYCODE_DPAD_UP || event.keyCode == KeyEvent.KEYCODE_DPAD_DOWN
      // Left/right/OK stay with the text field (cursor, keyboard); up/down leave it so the
      // remote never gets stuck in a field after the on-screen keyboard is dismissed.
      if (!vertical) return super.dispatchKeyEvent(event)
      if (event.action == KeyEvent.ACTION_DOWN) {
        focused.clearFocus()
        requestFocus()
      }
    }
    if (RemoteKeysModule.handle(event)) return true
    return super.dispatchKeyEvent(event)
  }
}
