package expo.modules.kulavoice

import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent

/**
 * "The device" for talk mode: any headset or earpiece the phone knows, and later the glasses
 * clip. Two jobs while talk mode is open:
 *
 * 1. the button: a MediaSession that receives KEYCODE_HEADSETHOOK / MEDIA_PLAY_PAUSE (and
 *    next/previous) and hands them to JS as one press each;
 * 2. the microphone: when a bluetooth headset is connected, the communication route goes to
 *    it (Android 12+: setCommunicationDevice; before: bluetooth SCO), so the speech
 *    recognizer hears the headset's mic rather than the phone's.
 *
 * Everything is undone in [stop].
 */
class Headset(private val ctx: Context, private val emit: (String, Map<String, Any?>) -> Unit) {
  private val main = Handler(Looper.getMainLooper())
  private val audio = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private var session: MediaSession? = null
  private var routed = false
  private var scoStarted = false
  private var watching = false

  private val devices = object : AudioDeviceCallback() {
    override fun onAudioDevicesAdded(added: Array<out AudioDeviceInfo>?) = emit("onRoute", info())
    override fun onAudioDevicesRemoved(removed: Array<out AudioDeviceInfo>?) = emit("onRoute", info())
  }

  // ---- the button ----------------------------------------------------------------------

  fun start() = main.post {
    if (session == null) {
      val s = MediaSession(ctx, "kula-talk")
      s.setCallback(object : MediaSession.Callback() {
        override fun onMediaButtonEvent(intent: Intent): Boolean {
          val ev: KeyEvent? = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT, KeyEvent::class.java) else @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT)
          if (ev == null) return super.onMediaButtonEvent(intent)
          val key = when (ev.keyCode) {
            KeyEvent.KEYCODE_HEADSETHOOK, KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_MEDIA_PLAY, KeyEvent.KEYCODE_MEDIA_PAUSE -> "press"
            KeyEvent.KEYCODE_MEDIA_NEXT -> "next"
            KeyEvent.KEYCODE_MEDIA_PREVIOUS -> "previous"
            KeyEvent.KEYCODE_MEDIA_STOP -> "stop"
            else -> return super.onMediaButtonEvent(intent)
          }
          // one event per press: on the key going up; a long press says so
          if (ev.action == KeyEvent.ACTION_UP) emit("onButton", mapOf("key" to key, "long" to (ev.eventTime - ev.downTime > 600), "code" to ev.keyCode))
          return true
        }
        // some headsets (and the system on a play/pause key) arrive as transport calls instead
        override fun onPlay() = emit("onButton", mapOf("key" to "press", "long" to false, "code" to KeyEvent.KEYCODE_MEDIA_PLAY))
        override fun onPause() = emit("onButton", mapOf("key" to "press", "long" to false, "code" to KeyEvent.KEYCODE_MEDIA_PAUSE))
      })
      s.setPlaybackState(
        PlaybackState.Builder()
          .setActions(PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_SKIP_TO_NEXT or PlaybackState.ACTION_SKIP_TO_PREVIOUS or PlaybackState.ACTION_STOP)
          .setState(PlaybackState.STATE_PLAYING, 0, 1f)
          .build(),
      )
      s.isActive = true
      session = s
    }
    // Android sends media buttons to the session of the app that played audio last. The
    // replies are spoken by the TTS engine's own process, so play a moment of silence here
    // to become that app.
    claimButtons()
    if (!watching) {
      audio.registerAudioDeviceCallback(devices, main)
      watching = true
    }
  }

  fun stop() = main.post {
    session?.let {
      it.isActive = false
      it.release()
    }
    session = null
    if (watching) {
      runCatching { audio.unregisterAudioDeviceCallback(devices) }
      watching = false
    }
    release()
  }

  /** A quarter second of silence through our own AudioTrack (see [start]). */
  fun claimButtons() {
    Thread {
      runCatching {
        val rate = 16000
        val samples = ShortArray(rate / 4)
        val track = AudioTrack.Builder()
          .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
          .setAudioFormat(AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(rate).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
          .setTransferMode(AudioTrack.MODE_STATIC)
          .setBufferSizeInBytes(samples.size * 2)
          .build()
        track.write(samples, 0, samples.size)
        track.play()
        Thread.sleep(300)
        track.stop()
        track.release()
      }
    }.apply { isDaemon = true }.start()
  }

  // ---- the microphone ------------------------------------------------------------------

  private fun isHeadset(d: AudioDeviceInfo) = d.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO ||
    (Build.VERSION.SDK_INT >= 31 && (d.type == AudioDeviceInfo.TYPE_BLE_HEADSET))

  private fun bluetoothOut(): AudioDeviceInfo? = audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS).firstOrNull {
    it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || it.type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP ||
      (Build.VERSION.SDK_INT >= 31 && (it.type == AudioDeviceInfo.TYPE_BLE_HEADSET || it.type == AudioDeviceInfo.TYPE_BLE_SPEAKER))
  }

  private fun wired(): AudioDeviceInfo? = audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS).firstOrNull {
    it.type == AudioDeviceInfo.TYPE_WIRED_HEADSET || it.type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES || it.type == AudioDeviceInfo.TYPE_USB_HEADSET
  }

  private fun typeName(t: Int): String = when (t) {
    AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "bluetooth"
    AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "bluetooth-media"
    AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "wired"
    AudioDeviceInfo.TYPE_USB_HEADSET -> "usb"
    else -> if (Build.VERSION.SDK_INT >= 31 && (t == AudioDeviceInfo.TYPE_BLE_HEADSET || t == AudioDeviceInfo.TYPE_BLE_SPEAKER)) "bluetooth-le" else "other"
  }

  /** What is connected and where the mic goes now. */
  fun info(): Map<String, Any?> {
    val bt = bluetoothOut()
    val w = wired()
    val d = bt ?: w
    val comm = if (Build.VERSION.SDK_INT >= 31) audio.communicationDevice else null
    return mapOf(
      "connected" to (d != null),
      "name" to d?.productName?.toString(),
      "type" to d?.let { typeName(it.type) },
      "micRouted" to routed,
      "route" to (comm?.let { typeName(it.type) } ?: if (@Suppress("DEPRECATION") audio.isBluetoothScoOn) "bluetooth" else "phone"),
    )
  }

  /**
   * Sends the microphone to a bluetooth headset if one is connected. A wired headset needs
   * nothing: Android uses its mic already. Returns whether a bluetooth route was set.
   */
  fun route(): Boolean {
    if (Build.VERSION.SDK_INT >= 31) {
      val dev = audio.availableCommunicationDevices.firstOrNull { isHeadset(it) } ?: return false
      routed = runCatching { audio.setCommunicationDevice(dev) }.getOrDefault(false)
    } else {
      if (audio.getDevices(AudioManager.GET_DEVICES_INPUTS).none { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO } && bluetoothOut() == null) return false
      @Suppress("DEPRECATION")
      runCatching {
        audio.startBluetoothSco()
        audio.isBluetoothScoOn = true
        scoStarted = true
      }
      routed = scoStarted
    }
    emit("onRoute", info())
    return routed
  }

  /** Gives the communication route back to the system. */
  fun release() {
    if (Build.VERSION.SDK_INT >= 31) {
      if (routed) runCatching { audio.clearCommunicationDevice() }
    } else if (scoStarted) {
      @Suppress("DEPRECATION")
      runCatching {
        audio.isBluetoothScoOn = false
        audio.stopBluetoothSco()
      }
      scoStarted = false
    }
    if (routed) {
      routed = false
      emit("onRoute", info())
    }
  }
}
