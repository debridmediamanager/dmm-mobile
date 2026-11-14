package com.debridmediamanager.alerts

import android.Manifest
import android.os.Build
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** What src/alerts.ts needs on Android, in place of expo-notifications, whose Android side brings Firebase. */
class AlertsModule : Module() {
  private val context get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("DmmAlerts")

    // A force stop clears the alarms, and the app starts again only when it is opened.
    OnCreate { appContext.reactContext?.let(Alerts::armAll) }

    AsyncFunction("request") { promise: Promise ->
      Alerts.channel(context)
      val permissions = appContext.permissions
      if (Build.VERSION.SDK_INT < 33 || permissions == null) return@AsyncFunction promise.resolve(Alerts.allowed(context))
      permissions.askForPermissions({ promise.resolve(Alerts.allowed(context)) }, Manifest.permission.POST_NOTIFICATIONS)
    }

    AsyncFunction("allowed") { Alerts.allowed(context) }

    AsyncFunction("scheduled") { Alerts.scheduled(context) }

    AsyncFunction("schedule") { alert: Map<String, Any?> ->
      Alerts.schedule(context, alert["id"] as String, (alert["at"] as Number).toLong(), alert["title"] as String, alert["body"] as String)
    }

    AsyncFunction("cancel") { id: String -> Alerts.cancel(context, id) }

    AsyncFunction("cancelAll") { Alerts.cancelAll(context) }
  }
}
