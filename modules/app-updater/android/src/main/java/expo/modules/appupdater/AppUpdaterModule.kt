package expo.modules.appupdater

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

/**
 * Sideloaded builds update themselves: the JS side downloads the release APK into the app's cache,
 * this hands it to Android's package installer. Android only accepts it if it's signed with the
 * same key as the installed app.
 */
class AppUpdaterModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("AppUpdater")

    Function("version") {
      @Suppress("DEPRECATION")
      context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: ""
    }

    Function("canInstall") {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.packageManager.canRequestPackageInstalls() else true
    }

    AsyncFunction("openInstallSettings") {
      val intent =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
        } else {
          Intent(Settings.ACTION_SECURITY_SETTINGS)
        }
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      try {
        context.startActivity(intent)
        true
      } catch (e: Exception) {
        false // e.g. Fire OS builds without this settings screen
      }
    }

    AsyncFunction("install") { path: String ->
      val file = File(path.removePrefix("file://")).canonicalFile
      // Only APKs the updater itself put in the app's cache
      if (!file.path.startsWith(context.cacheDir.canonicalPath + File.separator) || !file.name.endsWith(".apk") || !file.isFile) {
        throw IllegalArgumentException("Not a downloaded update: $path")
      }
      // expo-file-system's provider shares the cache directory with other apps on request
      val uri = FileProvider.getUriForFile(context, "${context.packageName}.FileSystemFileProvider", file)
      val intent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, "application/vnd.android.package-archive")
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      context.startActivity(intent)
    }
  }
}
