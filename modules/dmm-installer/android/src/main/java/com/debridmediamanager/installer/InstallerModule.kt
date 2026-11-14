package com.debridmediamanager.installer

import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** Which app installed DMM Mobile (com.android.vending for Google Play), so src/updates.ts knows whether fixes start on. */
class InstallerModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("DmmInstaller")

    // The installer of record: a store, Obtainium, an F-Droid client, the system's package installer; null after adb install.
    Constant("installer") {
      val context = appContext.reactContext ?: return@Constant null
      runCatching {
        if (Build.VERSION.SDK_INT >= 30) context.packageManager.getInstallSourceInfo(context.packageName).installingPackageName
        else @Suppress("DEPRECATION") context.packageManager.getInstallerPackageName(context.packageName)
      }.getOrNull()
    }
  }
}
