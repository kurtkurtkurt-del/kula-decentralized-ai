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
(a local chat that fails ends the promise instead of leaving the device busy forever).
