package com.debridmediamanager.alerts

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import org.json.JSONObject

/**
 * New-episode alerts as local notifications, with nothing but the platform: an alarm per alert (inexact on Android 12
 * and later, which need a permission for exact ones), kept in shared preferences so they can be set again after a
 * restart, an app update or a force stop, all of which clear the alarms.
 */
internal object Alerts {
  private const val CHANNEL = "episodes"
  private const val ACTION = "com.debridmediamanager.alerts.ALERT"
  private const val DAY = 24 * 60 * 60 * 1000L

  private fun store(context: Context) = context.getSharedPreferences("dmm-alerts", Context.MODE_PRIVATE)
  private fun notifications(context: Context) = context.getSystemService(NotificationManager::class.java)

  fun allowed(context: Context) = notifications(context).areNotificationsEnabled()

  /** Same id and name as the expo-notifications channel of 1.1 and 1.2, so a user's settings for it stay. */
  fun channel(context: Context) {
    if (Build.VERSION.SDK_INT >= 26) notifications(context).createNotificationChannel(NotificationChannel(CHANNEL, "New episodes", NotificationManager.IMPORTANCE_DEFAULT))
  }

  fun scheduled(context: Context): List<Map<String, Any>> = store(context).all.mapNotNull { (id, value) ->
    val alert = runCatching { JSONObject(value as String) }.getOrNull() ?: return@mapNotNull null
    mapOf("id" to id, "at" to alert.getLong("at").toDouble(), "title" to alert.getString("title"), "body" to alert.getString("body"))
  }

  fun schedule(context: Context, id: String, at: Long, title: String, body: String) {
    store(context).edit().putString(id, JSONObject().put("at", at).put("title", title).put("body", body).toString()).commit()
    arm(context, id, at)
  }

  fun cancel(context: Context, id: String) {
    context.getSystemService(AlarmManager::class.java).cancel(alarm(context, id))
    store(context).edit().remove(id).commit()
  }

  fun cancelAll(context: Context) = store(context).all.keys.forEach { cancel(context, it) }

  /** Sets every kept alert's alarm again; one more than a day overdue (the phone was off) is dropped instead. */
  fun armAll(context: Context) {
    val now = System.currentTimeMillis()
    for (alert in scheduled(context)) {
      val at = (alert["at"] as Double).toLong()
      if (at < now - DAY) store(context).edit().remove(alert["id"] as String).commit() else arm(context, alert["id"] as String, at)
    }
  }

  fun fire(context: Context, id: String) {
    val alert = store(context).getString(id, null)?.let { runCatching { JSONObject(it) }.getOrNull() } ?: return
    store(context).edit().remove(id).commit()
    channel(context)
    val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(context, CHANNEL) else @Suppress("DEPRECATION") Notification.Builder(context)
    builder
      .setSmallIcon(R.drawable.dmm_alert_icon)
      .setColor(0xFF00A0B0.toInt())
      .setContentTitle(alert.getString("title"))
      .setContentText(alert.getString("body"))
      .setWhen(alert.getLong("at"))
      .setShowWhen(true)
      .setAutoCancel(true)
    context.packageManager.getLaunchIntentForPackage(context.packageName)?.let {
      builder.setContentIntent(PendingIntent.getActivity(context, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
    }
    notifications(context).notify(id, 0, builder.build())
  }

  private fun arm(context: Context, id: String, at: Long) {
    val alarms = context.getSystemService(AlarmManager::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, alarm(context, id))
    else alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, alarm(context, id))
  }

  // The id in the data makes each alert's intent, and so its alarm, a separate one.
  private fun alarm(context: Context, id: String): PendingIntent = PendingIntent.getBroadcast(
    context,
    0,
    Intent(ACTION, Uri.fromParts("dmm-alert", id, null), context, AlertReceiver::class.java),
    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
  )

  fun receive(context: Context, intent: Intent) {
    if (intent.action == ACTION) intent.data?.schemeSpecificPart?.let { fire(context, it) } else armAll(context)
  }
}

class AlertReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) = Alerts.receive(context, intent)
}
