package expo.modules.kulavoice

import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.AlarmClock
import android.provider.Settings
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The JS face of kula-voice (src/voice/native.ts): talk mode's native side. The speech
 * itself is expo-speech-recognition (in) and expo-speech (out); this module adds what they
 * do not: the headset button and the bluetooth mic route (Headset.kt), the message
 * notifications (MessageListener.kt), and the clock and messaging apps' own intents. Nothing
 * here sends a message or talks to the network: a draft opens the messaging app with the
 * text filled in and the user presses send there.
 */
class KulaVoiceModule : Module() {
  private val context: Context get() = appContext.reactContext ?: throw CodedException("no react context")
  private var headset: Headset? = null

  private fun open(intent: Intent): Boolean {
    val activity = appContext.currentActivity
    return try {
      if (activity != null) activity.startActivity(intent) else context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      true
    } catch (e: ActivityNotFoundException) {
      false
    } catch (e: SecurityException) {
      false
    }
  }

  private fun msgMap(m: MessageListener.Msg) = mapOf("key" to m.key, "pkg" to m.pkg, "app" to m.app, "title" to m.title, "text" to m.text, "at" to m.at.toDouble())

  override fun definition() = ModuleDefinition {
    Name("KulaVoice")
    Events("onButton", "onRoute", "onMessage")

    OnDestroy {
      MessageListener.onMessage = null
      headset?.stop()
      headset = null
    }

    // --- talk mode open / closed ------------------------------------------------------
    // open: the headset button comes to JS, a bluetooth headset gets the mic, new messages
    // are announced as events. closed: all of it given back.
    Function("startTalk") { routeMic: Boolean ->
      val h = headset ?: Headset(context) { name, body -> sendEvent(name, body) }.also { headset = it }
      h.start()
      MessageListener.onMessage = { m -> sendEvent("onMessage", msgMap(m)) }
      if (routeMic) h.route() else false
    }
    Function("stopTalk") {
      MessageListener.onMessage = null
      headset?.stop()
    }
    Function("headsetInfo") { (headset ?: Headset(context) { _, _ -> }).info() }
    Function("routeMic") { (headset ?: Headset(context) { name, body -> sendEvent(name, body) }.also { headset = it }).route() }
    Function("releaseMic") { headset?.release() }
    /** After a reply was spoken (by the TTS engine's process): become the media-button app again. */
    Function("claimButtons") { headset?.claimButtons() }

    // --- messages ---------------------------------------------------------------------
    Function("notificationAccess") { MessageListener.granted(context) }
    Function("openNotificationAccess") {
      val component = ComponentName(context, MessageListener::class.java)
      val detail = if (Build.VERSION.SDK_INT >= 30) {
        Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS).putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME, component.flattenToString())
      } else null
      (detail != null && open(detail)) || open(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)) ||
        open(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}")))
    }
    /** The app's own settings page: on Android 13+ a sideloaded apk must "allow restricted settings" there first. */
    Function("openAppSettings") { open(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))) }
    Function("recentMessages") {
      if (MessageListener.recent().isEmpty()) MessageListener.seed()
      MessageListener.recent().map { msgMap(it) }
    }
    Function("clearMessages") { MessageListener.clear() }

    // --- the clock app ----------------------------------------------------------------
    Function("setAlarm") { hour: Int, minute: Int, label: String? ->
      val i = Intent(AlarmClock.ACTION_SET_ALARM)
        .putExtra(AlarmClock.EXTRA_HOUR, hour)
        .putExtra(AlarmClock.EXTRA_MINUTES, minute)
        .putExtra(AlarmClock.EXTRA_SKIP_UI, true)
      if (!label.isNullOrBlank()) i.putExtra(AlarmClock.EXTRA_MESSAGE, label)
      open(i)
    }
    Function("setTimer") { seconds: Int, label: String? ->
      val i = Intent(AlarmClock.ACTION_SET_TIMER)
        .putExtra(AlarmClock.EXTRA_LENGTH, seconds)
        .putExtra(AlarmClock.EXTRA_SKIP_UI, true)
      if (!label.isNullOrBlank()) i.putExtra(AlarmClock.EXTRA_MESSAGE, label)
      open(i)
    }

    // --- drafts: never sent from here ---------------------------------------------------
    /** Opens `pkg` (or a chooser) with the text filled in; the user picks the chat and sends. */
    Function("draftMessage") { text: String, pkg: String? -> draft(text, pkg) }
  }

  private fun draft(text: String, pkg: String?): Boolean {
    val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)
    if (!pkg.isNullOrBlank()) {
      val sms = pkg == "com.google.android.apps.messaging" || pkg == "com.samsung.android.messaging" || pkg == "com.android.mms"
      if (sms && open(Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:")).putExtra("sms_body", text).setPackage(pkg))) return true
      if (open(Intent(send).setPackage(pkg))) return true
    }
    return open(Intent.createChooser(send, null))
  }
}
