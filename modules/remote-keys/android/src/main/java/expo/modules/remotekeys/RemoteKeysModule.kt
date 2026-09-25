package expo.modules.remotekeys

import android.view.KeyEvent
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
  }

  private fun emit(keyCode: Int, action: String, repeat: Int) {
    sendEvent("onKey", mapOf("keyCode" to keyCode, "action" to action, "repeat" to repeat))
  }

  companion object {
    @Volatile
    var enabled = false
    private var instance: WeakReference<RemoteKeysModule>? = null

    // D-pad, OK/Enter, menu, media and channel keys, digits 0-9
    private val CAPTURED: Set<Int> = setOf(
      19, 20, 21, 22, 23, 66, 160, 96, 82,
      85, 126, 127, 89, 90, 92, 93, 166, 167, 165, 172
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
