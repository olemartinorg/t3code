package expo.modules.t3agentnotifications

import android.app.Activity
import android.app.Application
import android.app.NotificationManager
import android.content.ComponentName
import android.content.Intent
import android.content.IntentFilter
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.ProcessLifecycleOwner
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.net.InetAddress

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [24, 26, 33, 36], manifest = Config.NONE)
class SandboxNotificationsTest {
 private val host = "11111111-1111-4111-8111-111111111111"
 private val installation = "22222222-2222-4222-8222-222222222222"
 private val stableTask = "33333333-3333-4333-8333-333333333333"
 private val now = 1791936000000L
 private lateinit var context: Application
 private lateinit var manager: NotificationManager
 private lateinit var lifecycle: LifecycleRegistry
 @Before fun setup() {
  context = RuntimeEnvironment.getApplication(); manager = context.getSystemService(NotificationManager::class.java)
  context.getSharedPreferences("sandbox-notification-registrations", 0).edit().clear().commit()
  shadowOf(manager).setNotificationsEnabled(true); lifecycle = ProcessLifecycleOwner.get().lifecycle as LifecycleRegistry; lifecycle.currentState = Lifecycle.State.CREATED
  val launcher = ComponentName(context, Activity::class.java); shadowOf(context.packageManager).addActivityIfNotPresent(launcher)
  shadowOf(context.packageManager).addIntentFilterForActivity(launcher, IntentFilter(Intent.ACTION_MAIN).apply { addCategory(Intent.CATEGORY_LAUNCHER) })
  SandboxNotifications.configure(context, installation, mapOf(host to true)); SandboxNotifications.setThread(context, null, null)
 }
 private fun target() = JSONObject().put("kind", "sandbox").put("taskId", "owned").put("stableId", stableTask).put("conversationId", "thread")
 private fun payload() = JSONObject().put("protocol", "sandbox.android.1").put("eventId", "a".repeat(64)).put("serverId", host).put("installationId", installation).put("category", "question").put("target", target()).put("nativeEventId", "request").put("occurredAt", "2026-10-14T00:00:00.000Z").put("expiresAt", "2026-10-14T00:02:00.000Z").put("label", "Owned task").put("conversationLabel", "Owned thread")
 private fun deliver(value: JSONObject = payload()) = SandboxNotifications.receive(context, mapOf("protocol" to "sandbox.android.1", "payload" to value.toString()), now)
 @Test fun backgroundDeliveryNeedsNoLanOrClerkAndDeduplicatesExactEvent() { deliver(); assertEquals(1, manager.activeNotifications.size); deliver(); assertEquals(1, manager.activeNotifications.size) }
 @Test fun disabledAndRemovedHostSuppressImmediatelyAndCancelExistingCards() { deliver(); SandboxNotifications.configure(context, installation, mapOf(host to false)); assertEquals(0, manager.activeNotifications.size); deliver(payload().put("eventId", "b".repeat(64))); assertEquals(0, manager.activeNotifications.size); SandboxNotifications.configure(context, installation, emptyMap()); deliver(); assertEquals(0, manager.activeNotifications.size) }
 @Test fun expiredWrongInstallationAndExtraNavigationPayloadsAreRejected() { deliver(payload().put("expiresAt", "2026-10-13T23:59:59.000Z")); deliver(payload().put("installationId", stableTask)); deliver(payload().put("url", "https://untrusted.example")); deliver(payload().put("target", target().put("url", "https://untrusted.example"))); assertEquals(0, manager.activeNotifications.size) }
 @Test fun onScreenThreadSuppressesButOtherThreadStillAlerts() { lifecycle.currentState = Lifecycle.State.RESUMED; SandboxNotifications.setThread(context, host, target().toString()); deliver(); assertEquals(0, manager.activeNotifications.size); deliver(payload().put("eventId", "b".repeat(64)).put("target", target().put("conversationId", "other"))); assertEquals(1, manager.activeNotifications.size) }
 @Test fun deniedAndroidPermissionDoesNotDisplayOrReplayLater() { shadowOf(manager).setNotificationsEnabled(false); deliver(); assertEquals(0, manager.activeNotifications.size); shadowOf(manager).setNotificationsEnabled(true); deliver(); assertEquals(0, manager.activeNotifications.size) }
 @Test fun externalProjectlessThreadKeepsItsNativeIdentity() { val external = JSONObject().put("kind", "t3").put("environmentId", stableTask).put("projectId", JSONObject.NULL).put("conversationId", "external-thread"); deliver(payload().put("target", external)); assertEquals(1, manager.activeNotifications.size); assertTrue(SandboxNotifications.targetKey(host, external).contains("external-thread")) }
 @Test fun privateAddressPolicyRejectsLoopbackPublicAndMulticast() { for (value in listOf("192.168.1.2", "10.0.0.2", "172.20.1.1", "fd00::2", "fe80::1")) assertTrue(value, SandboxLanTransport.localAddress(InetAddress.getByName(value))); for (value in listOf("127.0.0.1", "0.0.0.0", "8.8.8.8", "::1", "2001:4860:4860::8888", "ff02::1")) assertFalse(value, SandboxLanTransport.localAddress(InetAddress.getByName(value))) }
}
