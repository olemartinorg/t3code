package expo.modules.t3agentnotifications

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

/** FCM is presentation only. It never opens a socket, issues a command or changes PC presence. */
object SandboxNotifications {
  private const val STORE = "sandbox-notification-registrations"
  private const val CHANNEL = "sandbox-alerts"
  @Volatile private var onScreen: String? = null
  fun configure(context: Context, installationId: String, hosts: Map<String, Boolean>) {
    UUID.fromString(installationId); hosts.keys.forEach { UUID.fromString(it) }
    val prefs = context.getSharedPreferences(STORE, Context.MODE_PRIVATE)
    val previous = prefs.getString("installationId", null)
    if (previous != null && previous != installationId) prefs.edit().clear().commit()
    prefs.edit().putString("installationId", installationId).putString("hosts", JSONObject(hosts).toString()).commit()
    val manager = context.getSystemService(NotificationManager::class.java)
    manager.activeNotifications.filter { it.tag?.startsWith("sandbox:") == true }.forEach {
      val hostId = it.notification.extras.getString("sandbox.host")
      if (hostId == null || hosts[hostId] != true) manager.cancel(it.tag, it.id)
    }
  }
  fun setThread(context: Context, serverId: String?, target: String?) {
    onScreen = if (serverId != null && target != null) targetKey(serverId, JSONObject(target)) else null
    if (onScreen != null) context.getSystemService(NotificationManager::class.java).activeNotifications.filter {
      it.tag?.startsWith("sandbox:") == true && it.notification.extras.getString("sandbox.target") == onScreen
    }.forEach { context.getSystemService(NotificationManager::class.java).cancel(it.tag, it.id) }
  }
  internal fun targetKey(serverId: String, target: JSONObject): String {
    UUID.fromString(serverId)
    val expected = when (target.getString("kind")) { "sandbox" -> setOf("kind", "taskId", "stableId", "conversationId"); "t3" -> setOf("kind", "environmentId", "projectId", "conversationId"); else -> emptySet() }; require(target.keys().asSequence().toSet() == expected)
    val conversationId = target.getString("conversationId"); require(conversationId.isNotBlank())
    return when (target.getString("kind")) {
      "sandbox" -> { val stableId = target.getString("stableId"); UUID.fromString(stableId); require(target.getString("taskId").isNotBlank()); "$serverId:sandbox:$stableId:$conversationId" }
      "t3" -> { val environmentId = target.getString("environmentId"); UUID.fromString(environmentId); val project = if (target.isNull("projectId")) null else target.getString("projectId"); "$serverId:t3:$environmentId:${project ?: ""}:$conversationId" }
      else -> throw IllegalArgumentException("Unsupported Sandbox notification target")
    }
  }
  private fun timestamp(value: String): Long? {
    for (format in arrayOf("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", "yyyy-MM-dd'T'HH:mm:ss'Z'")) {
      try { val parser = SimpleDateFormat(format, Locale.ROOT); parser.timeZone = TimeZone.getTimeZone("UTC"); parser.isLenient = false; val position = java.text.ParsePosition(0); val parsed = parser.parse(value, position); if (parsed != null && position.index == value.length) return parsed.time } catch (_: Exception) { }
    }
    return null
  }
  fun receive(context: Context, data: Map<String, String>, now: Long = System.currentTimeMillis()) {
    try {
      if (data["protocol"] != "sandbox.android.1") return
      val raw = data["payload"] ?: return; if (raw.length > 4096) return
      val payload = JSONObject(raw)
      if (payload.getString("protocol") != "sandbox.android.1") return
      val allowed = setOf("protocol", "eventId", "serverId", "installationId", "category", "target", "nativeEventId", "occurredAt", "expiresAt", "label", "conversationLabel")
      if (payload.keys().asSequence().toSet() != allowed) return
      val eventId = payload.getString("eventId"); if (!Regex("[a-f0-9]{64}").matches(eventId)) return
      val hostId = payload.getString("serverId"); UUID.fromString(hostId)
      val prefs = context.getSharedPreferences(STORE, Context.MODE_PRIVATE)
      if (payload.getString("installationId") != prefs.getString("installationId", null)) return
      val hosts = JSONObject(prefs.getString("hosts", "{}")!!); if (!hosts.optBoolean(hostId, false)) return
      val expiresAt = timestamp(payload.getString("expiresAt")) ?: return
      if (expiresAt <= now || expiresAt > now + 125_000 || timestamp(payload.getString("occurredAt")) == null) return
      val target = payload.getJSONObject("target"), key = targetKey(hostId, target)
      val category = payload.getString("category")
      val categoryLabel = when(category) { "question" -> "Question waiting"; "approval" -> "Approval waiting"; "completed" -> "Turn completed"; "failed" -> "Turn failed"; else -> return }
      if (payload.getString("nativeEventId").isBlank()) return
      val label = payload.getString("label"), conversation = payload.getString("conversationLabel")
      if (label.length > 80 || conversation.length > 80) return
      val seen = JSONObject(prefs.getString("seen", "{}")!!)
      seen.keys().asSequence().toList().filter { seen.optLong(it) <= now }.forEach { seen.remove(it) }
      if (seen.has(eventId)) return
      // Mark even suppressed/permission-denied alerts so permission/resume does not replay them.
      seen.put(eventId, expiresAt); prefs.edit().putString("seen", seen.toString()).commit()
      if (ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED) && onScreen == key) return
      if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return
      val manager = context.getSystemService(NotificationManager::class.java)
      if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(NotificationChannel(CHANNEL, "Sandbox alerts", NotificationManager.IMPORTANCE_HIGH))
      val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return
      val link = Uri.Builder().scheme("sandbox-companion").authority("notification").appendQueryParameter("payload", raw).build()
      launch.action = Intent.ACTION_VIEW; launch.data = link; launch.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
      val pending = PendingIntent.getActivity(context, eventId.take(7).toInt(16), launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
      val extras = android.os.Bundle().apply { putString("sandbox.host", hostId); putString("sandbox.target", key) }
      val notification = NotificationCompat.Builder(context, CHANNEL).setSmallIcon(context.applicationInfo.icon)
        .setContentTitle(label.ifBlank { "Sandbox" }).setContentText("$categoryLabel · $conversation")
        .setPriority(NotificationCompat.PRIORITY_HIGH).setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
        .setAutoCancel(true).setContentIntent(pending).addExtras(extras)
      if (Build.VERSION.SDK_INT >= 26) notification.setTimeoutAfter(expiresAt - now)
      manager.notify("sandbox:$eventId", 1, notification.build())
    } catch (_: Exception) { /* Invalid/unregistered data is ignored without exposing private payloads. */ }
  }
}
