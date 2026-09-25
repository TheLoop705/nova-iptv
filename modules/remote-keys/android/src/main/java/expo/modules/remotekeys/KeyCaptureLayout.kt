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
      when (event.keyCode) {
        // Up/down leave the field so the remote never gets stuck after the keyboard is dismissed
        KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN ->
          if (event.action == KeyEvent.ACTION_DOWN) {
            focused.clearFocus()
            requestFocus()
          }
        // The field itself needs cursor movement, OK/Enter (open keyboard / submit) and digits
        KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent.KEYCODE_DPAD_CENTER,
        KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER,
        in KeyEvent.KEYCODE_0..KeyEvent.KEYCODE_9 -> return super.dispatchKeyEvent(event)
        // Menu (held = voice search), media, channel and search keys still go to the app
        else -> Unit
      }
    }
    if (RemoteKeysModule.handle(event)) return true
    return super.dispatchKeyEvent(event)
  }
}
