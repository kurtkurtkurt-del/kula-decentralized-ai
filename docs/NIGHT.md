# the night

A kula night: the phone, on charge and idle, runs a small model for a project the person
chose, from the moment the conditions are met to the moment one breaks or the window
closes, and leaves a report in the morning. Code: `app/src/night/`. The user side is in
[GUIDE.en.md](GUIDE.en.md); how the work is spread over devices is in
[ARCHITECTURE.md](ARCHITECTURE.md), section 4.5.

## the pieces

| file | role |
|---|---|
| `NightWorker.ts` | the interface both workers implement: `start`, `stop`, `status`, `subscribe`; the status shape the card reads |
| `SimulatedWorker.ts` | a counter that moves by the passport's estimate; Expo Go, iOS, the web, a phone with no model yet |
| `LlamaWorker.ts` | the real one: a model in apart mode on this phone and its peers, one unit in flight per device |
| `jobs.ts` | units, the `JobSource` interface, `DemoJobs` (60 bundled prompts), `ServerJobs` (throws `notyet`) |
| `queue.ts` | `ResumableJobs`: the pile kept in the kv-store so a cut night continues where it stopped |
| `conditions.ts` | `evaluate(facts, rules)`: may the night start, must it pause, and which condition is missing |
| `scheduler.ts` | the state machine over the worker: waiting, running, paused, done |
| `report.ts` | segments, the morning report, the previous nights |
| `notify.ts` | the sticky notification while the night runs |
| `useNight.ts` | wires the real clock, the real worker and the screens together |

## conditions

`evaluate` is pure: the facts of the moment and the person's rules in, a verdict out, each
condition as its own flag so the card can say which one is missing. When more than one is
missing, the reason shown follows this order: the person's own choice first, then what
needs their hand, then the clock, then the plug, the battery, the heat, the network.

| flag | meaning | source |
|---|---|---|
| `off` | "work tonight" is switched off (`night.want`) | the switch on the passport card |
| `noproject` | no kept project to work for | the projects tab |
| `nopassport` | the phone was never measured | the passport tab |
| `window` | outside the night window (`from`, `to` in the profile) | the clock |
| `charge` | not charging, while "only on charge" is on (`night.charge`, default on) | `expo-battery` |
| `battery` | below the threshold: 20, 30, 50 or 80 % (`night.minBattery`, default 30) | `expo-battery` |
| `hot` | the passport's last measurement was throttling (thermal status ≥ 3) or the battery was over 42 °C | the passport, not a live sensor |
| `wifi` | not on wi-fi, while "wi-fi only" is on | `expo-network` |

The facts are re-read every 30 s and on every change of plug, level, network or foreground.

## the scheduler

```
waiting ──conditions ok, window open, not done tonight──▶ running
running ──a condition breaks (plug, battery, heat, wi-fi)──▶ paused    (segment kept)
paused  ──conditions back, same window──▶ running                        (pile continued)
running / paused ──window closes, pile empty, or "end now"──▶ done      (report, card)
done ──the next window opens──▶ waiting
```

Everything it needs is handed in (clock, worker, store), so the machine is driven in tests
with a fake clock. What must survive a restart of the app during the night is in the
kv-store: the open night (`night.start`), the segments so far (`night.segments`), the pile
(`night.queue`), and the key of the night already finished (`night.done`, one start per
window). When the app is opened again the open night is found and continues from the pile.

### a segment

The worker runs from the moment the conditions are met to the moment one breaks. Each stop
leaves a segment: start, end, tokens, units, checked, wrong, the devices and their tok/s,
the model, the card's kWh. Units in flight when the worker is stopped go back to the front
of the pile.

## the work

A night is cut into **units**: one prompt, a cap on tokens, a kind, and now and then a
known answer.

| kind | the instruction in front of it | answer |
|---|---|---|
| classify | "Answer with exactly one lowercase word and nothing else." | one word |
| summarise | "Summarise the text in one short sentence. No preamble." | one sentence |
| translate | "Translate the line. Answer with the translation only." | one line, en→tr or en→de |

v0 has no server side for the work. `DemoJobs` is a bundled list of 60 short, harmless
prompts; results stay on the phone (`night.results`). About one classify unit in eight
carries a known answer: the first word of the reply, lowercased, is compared. This is the
trust idea in its first form: a device whose known answers come out wrong is not to be
trusted with the rest. `ServerJobs` is the shape of what comes next and names the RPC it
will call.

## the loop

`LlamaWorker.start` picks the model: the chosen one in settings, else the largest local
model that fits by the passport. It loads it in **apart mode** with the saved peers, alone
when there are none or none answers. Then every device runs its own small loop: take a
unit, chat it on that device, hand the result back, take the next. One unit in flight per
device, so a slow phone never holds a fast one back. Beyin's rule: jobs are split, models
are not.

A device that fails is out for five minutes and its unit goes back on the pile; the others
carry on; the night does not end. A device marked out and later answering comes back by
itself. `stop()` ends every loop and reports the totals; a `stop()` during loading unloads
once more when the load finishes.

## the report

In the morning, `app/night/report.tsx`:

| line | from |
|---|---|
| units, and the share of known answers that were right | the segments |
| tok/s per device | tokens / seconds per device |
| time worked (pauses left out) and the number of segments | the segments |
| Wh | hours × the measured W of this phone; 3 W when the passport has no wattage, marked as an assumption |
| the difference to the average of the previous nights, and the best night | `night.reports`, the last ones kept |

The passport card shows "last night: n units · tok/s · wh" and the "work tonight" switch.
The card's own kWh figure is the old one, 4 W for this phone and 2 W per extra device, so
the two numbers differ on purpose: one is the card's running estimate, the other the
morning's measured account.

The report is also sent as a `nightReport` job through the outbox, but only to the demo
server (`night_report`, once per client id); the live Supabase project has no such RPC yet,
so there the report stays "on this phone only". `contribution_end` goes with the totals as
before; `units`, `checked` and `wrong` ride along and the server does not read them yet.

## settings

| setting | where | key | default |
|---|---|---|---|
| work tonight | the passport card | `night.want` | on |
| only on charge | settings → night | `night.charge` | on |
| battery at least 20 / 30 / 50 / 80 % | settings → night | `night.minBattery` | 30 |
| the window, from and to | the profile | profile | as before |
| wi-fi only | the profile | profile | as before |
| the project | the projects tab, "tonight" | `night.project` | the first kept project |

## the person's own projects (5.11.2026)

The projects tab (`app/src/tasks/`, screens `(tabs)/projects.tsx`, `task/new.tsx`,
`task/[id].tsx`) holds the person's own night work: a title, what they want, photos (kept
small in the app's document folder; a vision model reads them, below), the answer's form and
length, and a calibration: its own hours (the night window by default), which nights (every,
weekdays, once), how carefully (quick: one pass; careful: draft → critique → final; very:
two critique rounds), the model (the best that fits by default), only on charge. Before
saving, `tasks/estimate.ts` says how much fits tonight from the model's tok/s (the bench's
when measured, else the passport's estimate). Everything is in the kv-store (`tasks.list`)
and files; nothing goes to a server.

At night, `tasks/jobs.ts` (ProjectJobs) hands the projects' steps to the real worker as
units (`own: true`, their own messages and budgets), one step per project at a time, only
while a project is due (`tasks/schedule.ts isDue`: its hours, its nights, not done in this
night, the plug). In the network's night they go first on the pile (`FirstOf`); outside it,
the scheduler opens an **own night** (slug `your-projects`) when a project is due and the
global rules hold (plug, battery threshold, heat, passport; not wi-fi, not "work tonight"):
no contribution start or end, no card, no report, the network's night not marked done. Every
step is written to the project as it finishes, so a run cut by the plug or the window goes
on from the next step. The brain log gets a line per step; a local notification says when an
answer is ready; the morning report lists the projects that came in. "Run now" runs the same
steps while the app is open and holds the night back meanwhile.

## photos (10.11.2026)

A project's photos are read before its run by the **vision model**: the one picked in
settings › vision model (`llm.settings.visionModelId`), else the smallest vision model on the
phone. The catalog has three (`app/src/llm/catalog.ts`, each with its `mmproj`, the image
encoder llama.cpp's `mtmd` needs): SmolVLM 500M (0.5 GB with its encoder, any phone), SmolVLM2
2.2B (1.7 GB, 6 GB phones), Gemma 3 4B (3.3 GB, 8 GB phones).

- **When:** the night calls `tasks/seen.ts` through `LlamaWorker`'s `prepare` hook *before* it
  loads its own model, so nothing else is in RAM; "run now" calls it before the project's
  model is loaded. The vision model is loaded next to whatever is loaded (`describeImages` in
  `kula_llama.cpp`: a second, short-lived model, context and mmproj), asked for a short,
  factual description of each photo plus any visible text (with the project's question), and
  freed again.
- **Where it goes:** the reading is kept on the project (`task.seen`, until the photos change)
  and goes into every step's prompt (draft, critique, final), marked as the vision model's
  ("SmolVLM 500M, a vision model on this phone, looked at them and wrote: …"). The step
  models themselves stay text models; the project's own model choice is unchanged.
- **Without a vision model:** the photos stay with the project, the run goes on the text alone
  (the steps say the photos could not be seen), the brain log says so, and the run records
  `photos: { n, by: null }`: the project page and the morning report say "photos not read: no
  vision model" and how to get one.
- **Where:** always on this phone. In apart or split mode only text goes to the other devices.
- Photos are scaled on the phone before they reach the model (`Vision.kt`): 768 px on the long
  side for one photo, 512 for two or three, 384 for more; SmolVLM-style encoders cut an image
  into tiles of 81 tokens each, so a full 1280 px photo would cost ~1 400 tokens.

The chat uses the same pieces (`llm/vision.ts`): a chat model that is itself a vision model
gets the photo directly (its mmproj loaded next to it, `generateWithImages`); a text model gets
the vision model's description in the prompt, both in RAM when the passport says they fit,
else the chat model is unloaded for the reading and loaded again (the chat says so).

The computer's chat page (`kula-node ui`, [NODE.md](NODE.md#the-chat-page)) does the same with
llama.cpp's own server (`node/src/ui/vision.ts`, the same prompt and the same note): a vision
model loaded *here* gets its image encoder (`--mmproj`, fetched and sha256-checked next to the
model) and the photo as an OpenAI `image_url` part ("seen by"); otherwise the vision model
picked in settings › model › vision model (else the smallest on the computer) reads it in a
second, short-lived llama-server on 127.0.0.1 and the chat model gets its text ("read by"),
also when the model runs on a phone: only text goes to the phones. Two differences: the
computer does not unload the model that is loaded when memory is tight (it says so and reads
anyway, one after the other), and the setting lives on the computer
(`~/.kula-node/ui-settings.json`), since `/v1` and guests use it too. The computer's night
projects do not take photos yet.

## limits, plainly

- **The night runs while the app is open.** Android's background task API (`expo-background-task`,
  WorkManager) runs short jobs at the system's pace, fifteen minutes apart at the earliest,
  and cannot carry a model for hours. The native `WorkerService` serves *other* devices in
  its own process; this loop is the app's. So: the real worker keeps the screen on (dimmed
  by the system) while it runs and lets it go on a pause or at the end; a phone whose screen
  is locked by hand pauses with the app and continues from the pile when opened again. The
  simulation does not touch the screen.
- A sticky, silent notification says the night is running (`notify.ts`, channel `night`);
  without the notification permission it is simply not shown.
- The heat flag comes from the last measurement, not a live sensor.
- Wattage is assumed (3 W) until the passport measures it.
- The work is a bundled demo list; nothing is fetched from a project yet.
- Devices in the night are the saved peers in apart mode; a computer joins through kula-node
  ([NODE.md](NODE.md)).

## tests

`app/src/__tests__/`: `night.test.ts` (round-robin over two devices, a failing device
skipped for five minutes, known answers counted, `stop()` ending the loops with totals, the
demo list handed out once), `conditions.test.ts` (every flag on its own, the order, the
window key), `scheduler.test.ts` (fake clock: start and stop, pause and resume, a dry pile,
a restart, "end now"), `report.test.ts` (totals, queue continuation), `engine-local.test.ts`
(a local chat that fails ends the promise instead of leaving the device busy forever),
`tasks-photos.test.ts` (photos read once and kept until they change, in every step, the run
saying who read them or that nobody could), `vision-route.test.ts` (direct, describe, swap,
none), `vision-store.test.ts` (both files downloaded and checked, the setting). On the JVM:
`VisionTest` (photo size, RGB packing, the prompt's image markers). Untested here, needs a
phone: mtmd's encoders on a real image, the memory of two models at once, the swap.
