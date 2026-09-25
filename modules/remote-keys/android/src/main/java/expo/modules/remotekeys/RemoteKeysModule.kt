package expo.modules.remotekeys

import android.content.Context
import android.view.KeyEvent
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.lang.ref.WeakReference

class RemoteKeysModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("RemoteKeys")

    Events("onKey")

    OnCreate {
      instance = WeakReference(this@RemoteKeysModule)
    }

    OnDestroy {
      if (instance?.get() === this@RemoteKeysModule) {
        instance = null
        enabled = false
      }
    }

    Function("setEnabled") { value: Boolean ->
      enabled = value
    }

    // Raise the on-screen keyboard for the focused text field. React Native won't re-show it for a
    // field that already has focus, and on Fire TV the open keyboard is what enables mic dictation.
    AsyncFunction("showKeyboard") {
      val activity = appContext.currentActivity ?: return@AsyncFunction false
      val view = activity.currentFocus as? EditText ?: return@AsyncFunction false
      val imm = activity.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
      imm.showSoftInput(view, 0)
    }.runOnQueue(Queues.MAIN)
  }

  private fun emit(keyCode: Int, action: String, repeat: Int) {
    sendEvent("onKey", mapOf("keyCode" to keyCode, "action" to action, "repeat" to repeat))
  }

  companion object {
    @Volatile
    var enabled = false
    private var instance: WeakReference<RemoteKeysModule>? = null

    // D-pad, OK/Enter, menu, media and channel keys, search/assistant keys, digits 0-9.
    // (Fire TV's Alexa mic button is reserved by the system and never reaches apps.)
    private val CAPTURED: Set<Int> = setOf(
      19, 20, 21, 22, 23, 66, 160, 96, 82,
      85, 126, 127, 89, 90, 92, 93, 166, 167, 165, 172,
      84, 219, 231, 175, 91
    ) + (7..16)

    /** Returns true when the key was forwarded to JS and must not reach Android's focus system. */
    fun handle(event: KeyEvent): Boolean {
      if (!enabled || event.keyCode !in CAPTURED) return false
      val module = instance?.get() ?: return false
      val action = when (event.action) {
        KeyEvent.ACTION_DOWN -> "down"
        KeyEvent.ACTION_UP -> "up"
        else -> return true
      }
      module.emit(event.keyCode, action, event.repeatCount)
      return true
    }
  }
}
