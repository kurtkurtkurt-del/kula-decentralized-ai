package expo.modules.kulavoice

import android.app.Notification
import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Parcelable
import android.provider.Settings
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

/**
 * The message notifications the secretary may read aloud ("read my messages", "what did
 * anna write"). The system binds this service only after the user turned on notification
 * access for kula; it keeps the last [KEEP] message notifications in memory (never on disk,
 * never sent anywhere) and forgets them when the process ends.
 *
 * A notification counts as a message when its category is MESSAGE or its app is a known
 * messenger. Group summaries, ongoing notifications and kula's own are skipped.
 */
class MessageListener : NotificationListenerService() {
  data class Msg(val key: String, val pkg: String, val app: String, val title: String, val text: String, val at: Long)

  companion object {
    const val KEEP = 50
    private val ring = ArrayDeque<Msg>()
    @Volatile private var live: MessageListener? = null
    /** Called on every new message (the module turns it into a JS event while talk mode is open). */
    @Volatile var onMessage: ((Msg) -> Unit)? = null

    val MESSENGERS = setOf(
      "com.whatsapp", "com.whatsapp.w4b", "org.telegram.messenger", "org.telegram.messenger.web", "org.thunderdog.challegram",
      "org.thoughtcrime.securesms", "com.google.android.apps.messaging", "com.samsung.android.messaging", "com.android.mms",
      "com.facebook.orca", "com.instagram.android", "com.discord", "com.Slack", "ch.threema.app", "com.viber.voip",
      "com.microsoft.teams", "im.vector.app", "com.wire", "jp.naver.line.android", "com.kakao.talk", "com.google.android.apps.dynamite",
    )

    fun recent(): List<Msg> = synchronized(ring) { ring.toList() }
    fun clear() = synchronized(ring) { ring.clear() }

    fun add(m: Msg) {
      synchronized(ring) {
        // the same notification updated with the same text (a re-post) is not a new message
        if (ring.any { it.key == m.key && it.text == m.text }) return
        ring.addLast(m)
        while (ring.size > KEEP) ring.removeFirst()
      }
      runCatching { onMessage?.invoke(m) }
    }

    /** Whether the user turned on notification access for this app. */
    fun granted(ctx: Context): Boolean {
      val flat = Settings.Secure.getString(ctx.contentResolver, "enabled_notification_listeners") ?: return false
      val mine = ComponentName(ctx, MessageListener::class.java)
      return flat.split(':').mapNotNull { ComponentName.unflattenFromString(it) }.any { it == mine }
    }

    /** What is in the shade right now, when the ring is still empty (access just turned on). */
    fun seed() {
      val l = live ?: return
      runCatching { l.activeNotifications?.sortedBy { it.postTime }?.forEach { l.take(it) } }
    }
  }

  override fun onListenerConnected() {
    live = this
    seed()
  }

  override fun onListenerDisconnected() {
    if (live === this) live = null
  }

  override fun onNotificationPosted(sbn: StatusBarNotification?) {
    sbn?.let { take(it) }
  }

  private fun appLabel(pkg: String): String = runCatching {
    val pm = packageManager
    val info = if (Build.VERSION.SDK_INT >= 33) pm.getApplicationInfo(pkg, PackageManager.ApplicationInfoFlags.of(0)) else @Suppress("DEPRECATION") pm.getApplicationInfo(pkg, 0)
    pm.getApplicationLabel(info).toString()
  }.getOrDefault(pkg)

  private fun take(sbn: StatusBarNotification) {
    if (sbn.packageName == packageName) return
    val n = sbn.notification ?: return
    if (n.flags and Notification.FLAG_GROUP_SUMMARY != 0) return
    if (sbn.isOngoing) return
    val isMessage = n.category == Notification.CATEGORY_MESSAGE || sbn.packageName in MESSENGERS
    if (!isMessage) return
    val extras = n.extras ?: return
    val app = appLabel(sbn.packageName)
    // MessagingStyle carries each message with its sender; take the newest
    val styled = lastStyled(extras)
    val conv = extras.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE)?.toString()
    val title = styled?.first?.let { s -> if (conv != null && conv != s) "$s · $conv" else s }
      ?: extras.getCharSequence(Notification.EXTRA_TITLE)?.toString() ?: app
    val text = styled?.second
      ?: extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString()
      ?: extras.getCharSequence(Notification.EXTRA_TEXT)?.toString() ?: return
    if (text.isBlank()) return
    add(Msg(sbn.key, sbn.packageName, app, title.trim(), text.trim().take(600), sbn.postTime))
  }

  private fun lastStyled(extras: Bundle): Pair<String?, String>? {
    val arr: Array<Parcelable>? = if (Build.VERSION.SDK_INT >= 33) extras.getParcelableArray(Notification.EXTRA_MESSAGES, Parcelable::class.java) else @Suppress("DEPRECATION") extras.getParcelableArray(Notification.EXTRA_MESSAGES)
    val last = arr?.lastOrNull() as? Bundle ?: return null
    val text = last.getCharSequence("text")?.toString() ?: return null
    val sender = last.getCharSequence("sender")?.toString()
      ?: (if (Build.VERSION.SDK_INT >= 28) last.getParcelableCompat("sender_person")?.name?.toString() else null)
    return sender to text
  }

  private fun Bundle.getParcelableCompat(key: String): android.app.Person? =
    if (Build.VERSION.SDK_INT >= 33) getParcelable(key, android.app.Person::class.java) else @Suppress("DEPRECATION") getParcelable(key)
}
