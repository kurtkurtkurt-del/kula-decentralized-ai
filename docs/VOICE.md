# Talk mode — a personal secretary on the phone

*5.11.2026 · v1, Android first*

The idea: a small device clipped behind the ear (on the glasses), the phone in the pocket.
You say "add sport tomorrow at six", "read my messages", "what did anna write", and the
phone answers out loud. It runs on the phone, so it can hear anything: nothing you say goes
anywhere. The device itself does not matter yet; v1 is the logic, ready for any headset to
plug into.

## What is in v1

| part | where | what it does |
|---|---|---|
| the loop | `app/src/voice/loop.ts` | a pure state machine: idle → listening → thinking → speaking → listening … with barge-in, silence and errors |
| speech in | `app/src/voice/listen.ts` | `expo-speech-recognition` around Android's `SpeechRecognizer`, on-device |
| speech out | `app/src/voice/speak.ts`, `text.ts` | `expo-speech` (Android TextToSpeech); the reply is spoken sentence by sentence while the model still writes; markdown and `<think>` are stripped |
| the secretary | `app/src/voice/intents.ts`, `tools.ts` | rule-based intents in Turkish, English and German; calendar, messages, drafts, alarms, timers, time, notes |
| the conversation | `app/src/voice/prompt.ts` | everything else goes to the loaded model as a concise secretary, last 6 turns of memory |
| wiring | `app/src/voice/useTalk.ts` | the controller the screen uses |
| the screen | `app/src/app/talk.tsx` | the dark screen with the circle; a **talk** button on the chat screen opens it |
| settings | `app/src/components/TalkSettings.tsx` | in settings → talk mode, and the talk screen's sheet |
| native | `app/modules/kula-voice` | headset button, bluetooth mic, message notifications, alarm/timer/draft intents |

### Talking

- Tap the circle once. From then on it is **hands-free**: after every reply it listens again.
  Two silent listens in a row and it rests (tap again).
- **Barge-in**: tap the circle, or press the headset button, while it thinks or speaks — it
  stops and listens.
- A long press on the headset button (or "bye", "görüşürüz", "tschüss") ends talk mode.
- Errors are said in one short sentence; it never retries an error on its own.

### What the secretary understands (examples)

| | Türkçe | English | Deutsch |
|---|---|---|---|
| add to the calendar | yarın 18:00'e spor ekle · cuma akşam 7'de dişçi ekle | add gym tomorrow at 6 pm | füge morgen um 18 uhr sport hinzu · trag freitag um 10:30 zahnarzt ein |
| read the calendar | bugün ne var · yarın programımda ne var | what's on my calendar today · what do I have tomorrow | was habe ich morgen · was steht heute an |
| read messages | mesajlarımı oku · anna ne yazdı | read my messages · what did anna write | lies meine nachrichten · was hat tom geschrieben |
| draft a message | anna'ya mesaj gönder yarın geliyorum | send a message to anna saying I'm late | schreib tom dass ich später komme |
| alarm / reminder | yarın sabah 7'ye alarm kur · bana 5'te anneyi aramayı hatırlat | wake me up at 6:30 · remind me at 5 to call mom | weck mich um 6:30 · erinnere mich um 17 uhr an den müll |
| timer | 10 dakikalık zamanlayıcı kur | set a timer for 10 minutes · remind me in 20 minutes to … | timer für 5 minuten |
| notes | not al: süt al · notlarımı oku · notlarımı sil | take a note … · read my notes | notiere … · lies meine notizen |
| time / date | saat kaç · bugün günlerden ne | what time is it · what's the date | wie spät ist es · der wievielte ist heute |

Anything else is a conversation with the model. With no model loaded the tools still work.

**Everything that writes is read back first** and done only after "evet / yes / ja"
("yarın saat 18:00 için spor ekliyorum, tamam mı?"). "hayır / no / nein" cancels; an unclear
answer is asked once more. A calendar hour from 1 to 7 without a morning/evening word is taken
as the evening; the read-back catches a wrong guess. A reminder on a later day than the clock
app can hold (it only knows "the next hh:mm") becomes a calendar entry.

**Messages are never sent by kula.** A draft opens the messaging app with the text filled in
(the app the person last wrote from, when known, e.g. WhatsApp; otherwise the share sheet),
and you press send there.

Every tool call is a line in the brain tab's decisions log (kind `voice`): what was heard,
what was done, whether it was confirmed.

## Privacy: what stays on the phone

**Everything**, by default:

- **Your voice.** Recognition runs on the phone (`requiresOnDeviceRecognition`, plus
  `EXTRA_PREFER_OFFLINE`). No audio file is kept.
- **Your words and kula's replies.** The model runs on the phone (or on your own devices if
  you split it); the conversation is kept in memory only while the talk screen is open.
- **Your messages.** The notification listener keeps the last 50 *message* notifications
  (category MESSAGE or a known messenger: WhatsApp, Telegram, Signal, SMS, Messenger, Threema…)
  in memory: app, sender/conversation title, text, time. Not on disk, not sent anywhere; gone
  when the app process ends.
- **Your calendar.** Read and written through Android's calendar provider on the phone.
- **Your notes.** In the app's local key-value store.

**The one exception** is the setting *on-device recognition only* (on by default). If the
phone cannot recognise speech on the device (no on-device recognizer, or the language's model
is not downloaded), talk mode says so and offers two ways out: download the language model
once, or allow *the phone's online recognizer*. Allowing it means your speech may go to that
recognizer's service (Google's, on most phones). The screen says so in gold for as long as it
is allowed.

**What the notification listener can see.** Android gives a notification listener *every*
notification. kula's ignores everything that is not a message notification, its own, group
summaries and ongoing ones; it reads only the title and the text a message notification
shows. Turning notification access off in Android's settings stops it at once.

On Android 13+ an apk installed from outside the Play Store is "restricted": the system hides
the notification-access switch until you open **app info → ⋮ → allow restricted settings**.
Talk mode's settings have a row that opens app info for this.

## The headset — and the glasses clip later

Any Bluetooth earpiece or headset works today:

- **Microphone.** While talk mode is open, a connected Bluetooth headset gets the
  communication route (Android 12+: `AudioManager.setCommunicationDevice`; older: Bluetooth
  SCO), so the recognizer hears the headset's mic. Wired headsets need nothing. Setting:
  *headset microphone*.
- **Sound.** Replies are spoken by Android's TTS and play where media plays (the headset when
  connected).
- **The button.** A `MediaSession` is active while talk mode is open and turns
  `KEYCODE_HEADSETHOOK` / `MEDIA_PLAY_PAUSE` (and play / pause) into a press: start talking,
  or interrupt. A long press ends talk mode. Android sends media buttons to the app that
  played audio last, so the module plays a quarter second of silence when talk mode opens.

**The glasses clip** maps onto the same three things. As a standard Bluetooth headset
(HFP for the mic, A2DP for sound, AVRCP for one button) it works with v1 unchanged. The
planned custom accessory (BLE) adds:

- a **BLE GATT service** `kula-talk` with: a *button* characteristic (notify: press / long /
  double), an *audio* characteristic (notify: 16 kHz mono Opus or PCM frames from its mic,
  for when classic Bluetooth audio is too heavy), a *state* characteristic (write: idle /
  listening / thinking / speaking, so the clip's LED or haptic can follow the loop), and
  battery level;
- on the phone, the BLE events feed the same loop events (`press`, `close`) and the audio
  frames feed a local recognizer (below) instead of the system's.

## Later

- **Wake word** "hey kula" on the phone (a small always-on keyword model, e.g. openWakeWord or
  Porcupine-style, in a foreground service), so the button becomes optional.
- **Fully local recognition**: whisper.cpp (the same ggml as llama.cpp, already in
  `modules/kula-llama`) with a small multilingual model, so recognition no longer depends on
  the phone vendor's recognizer or its offline packs.
- Local TTS voices (piper) for a voice that sounds the same on every phone.
- More tools: contacts ("call anna"), the shopping list, "what did I note yesterday", reading
  a whole conversation thread.

## For developers

- Tests: `app/src/__tests__/voice-*.test.ts` (loop, text, intents on a fixed clock, tools with
  expo-calendar and the native module mocked, the speaker).
- Native: `app/modules/kula-voice/android` — `KulaVoiceModule.kt` (the JS face),
  `Headset.kt` (MediaSession + audio route), `MessageListener.kt` (the notification
  listener). Permissions it adds: `MODIFY_AUDIO_SETTINGS`, `com.android.alarm.permission.SET_ALARM`,
  the `BIND_NOTIFICATION_LISTENER_SERVICE`-protected service. `RECORD_AUDIO` comes from
  expo-speech-recognition's plugin (it was in `blockedPermissions` before talk mode; it is no
  longer), `READ_CALENDAR` / `WRITE_CALENDAR` from app.json.
- Libraries: `expo-speech-recognition` 57.x (SDK-57 line, Expo module, new architecture),
  `expo-speech`, `expo-calendar` (SDK 57's object API: `getCalendars`, `listEvents`,
  `ExpoCalendar.createEvent`).
