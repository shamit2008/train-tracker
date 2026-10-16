# Trackside: trip-companion implementation plan

How to build the Flighty-inspired spec (`Trackside_Flighty_Inspired_App_Implementation_Plan.md`) on what Trackside
actually is today. Grounded in `docs/app-architecture-audit.md`; read that first. Each phase is a series of small,
reviewable changes, and each change ships with tests and a note of what wasn't tested.

## Decisions needed before Phase 2

| # | Decision | Why it matters | Recommendation |
|---|---|---|---|
| 1 | Join the Apple Developer Program ($99/year) | iOS push and Live Activities don't work with a free Apple ID; the App Store needs it anyway | Yes, before Phase 2 |
| 2 | Workers Paid ($5/month) or stay on Free | The alert engine runs on a schedule and decodes feeds; Free allows 10 ms CPU per run and 50 outbound requests | Start on Free with a small engine; move to Paid when it hits limits (Phase 2 measures this) |
| 3 | How pushes reach iPhones | Apple's push service needs HTTP/2, and it's unconfirmed whether a Worker can make HTTP/2 requests to it | Phase 2 starts with a one-day test. If it fails, send iOS pushes through Firebase Cloud Messaging (free), which the Worker can reach |
| 4 | Tabs on desktop too, or phones and app only | The four-tab layout suits phones; the desktop sidebar already works | Phones and app only; desktop keeps its sidebar, with Home added as a section |
| 5 | Version control for `app/` | Push, Live Activities and widgets are native code in `app/`, which is git-ignored | A private repo for `app/` before Phase 2 |

## Ground rules for every phase

- Trip identity stays **provider + train number + service date** (already true; see the audit). Every server-side
  match uses the service date, so tomorrow's train 5 never triggers today's alert.
- **Freshness contract:** every status shown or pushed carries the feed's own report time. Anything older than
  the existing stale threshold (`isStale`) is labelled "Last update h:mm", never "Live". Interpolated map positions
  stay labelled as estimates; nothing is described as GPS.
- No reasons for delays unless an alert says so; no trainset or "inbound train" claims without an equipment feed.
- Secrets stay Worker secrets; new ones are added to `worker/publish.mjs`, `.env.example`, `deploy.mjs` and
  `.githooks/pre-commit` (the secret scans).

## Phase 0: foundation (about 2 days)

1. **Put `app/` under version control** (private repo, `node_modules/` and `www/` ignored). *Blocks Phases 2–3.*
2. **Browser smoke tests.** Add Playwright as a dev dependency at the repo root, with a handful of tests against a
   local worker and a fixture feed: map loads, a train opens, trip planner saves a trip, sign-in works, phone layout
   shows the bottom sheet. *Gives Phase 1's restructure a safety net.*
3. **Feed fixtures.** Record a few real responses (Amtraker, two GTFS-RT railroads, NJT) into
   `worker/test/fixtures/` for the engine tests in Phase 2.
4. **Freshness contract** written into `index.html`'s helpers: one function returning `live | stale | offline` for a
   train, used everywhere instead of ad-hoc checks.

**Exit:** smoke tests pass in CI (add a GitHub Actions job next to `timetables.yml`); `app/` has history.

## Phase 1: passenger-first layout (about 1–2 weeks) — F01, part of F08/F14

All in `index.html`; no backend changes.

1. **Tabs on phones and in the app:** Home · Explore · Trips · Passport. Today's Stations tab becomes a "Trains |
   Stations" switch inside Explore. Desktop keeps Explore · Track a train · Stations, with the Home hero added at
   the top of Track a train.
2. **Home:** the active or next trip as a hero card (train, route, next stop, ETA at your stop, delay, "updated
   h:mm", progress). Actions: Track (opens the train), Share, Alerts (disabled until Phase 2). Then upcoming trips.
   Empty state: "Add a train" (trip planner) and "Explore live trains". Builds on `tripCard`/`liveLeg`.
3. **Trips:** upcoming, in progress, past; saved trains; Plan a trip; friends' trips.
4. **Train detail reordered for passengers:** status + next stop + ETA at your stop + delay; then the stop timeline;
   then the map; then notices; then speed, delay chart, compare and replay under "More details".
5. **States:** loading, live, stale ("Last update h:mm"), offline (no network: last known values, no "Live"),
   cancelled, completed, not yet running ("Scheduled. Live once running.").
6. **Offline trip view (F14):** cache each trip's last seen live snapshot with its report time in local storage, so
   Home shows it with an offline banner.

**Tests:** smoke tests for each tab and state; trip matching across service dates (two trips, same number, different
days). **Exit:** from launch, a saved trip's next stop, ETA and delay are visible with no taps; Explore unchanged on
desktop.

## Phase 2: alert engine and push notifications (about 2–3 weeks) — F02, F04 reminders

### First: the push-transport test (1 day)
Send one push from a Worker to a test iPhone: Apple direct (HTTP/2, `.p8` key signed with Web Crypto) and, if that
fails, Firebase Cloud Messaging. The result settles decision 3 and the app plugin: `@capacitor/push-notifications`
for Apple direct, a Firebase messaging plugin for Firebase.

### Backend (`worker/`)
- **Migration `0007_alerts.sql`:**
  - `devices` (user, platform, push token, created, last seen; deleted with the account)
  - `trip_alerts` (trip, event types wanted, thresholds; default on for the trip owner)
  - `trip_state` (trip, last snapshot JSON, report time, updated)
  - `journey_events` (id, trip, type, occurred at, detected at, source, `reported`/`inferred`, payload) — F05 later
  - `push_log` (event, device, result, time): the audit trail
- **Endpoints:** `POST/DELETE /v1/me/devices`, `PUT /v1/me/trips/:id/alerts`, `GET /v1/me/trips/:id/events`.
- **Scheduled job** (`[triggers] crons` every 2 minutes, `scheduled()` in `src/index.js`):
  1. Load trips that are live or start within 3 hours (index on `depart_at` exists).
  2. Fetch only the feeds those trips need: the existing railroad builds (cached) and, new, Amtraker for Amtrak,
     VIA and Brightline trips (one request per run).
  3. Match by provider + number + service date; build a snapshot: status, delay at the rider's stop, ETA there,
     cancelled, passed stops, report time.
  4. Diff against `trip_state` and apply rules in a pure function (`src/alerts.js`, unit-tested):
     delay change of 10+ minutes, cancellation, departure from the rider's stop, 30 minutes and ~5 minutes before
     arrival, a new alert text. A cooldown per trip and event type; an event key so a repeat is never sent twice.
  5. Write events, send pushes, log results; drop device tokens the push service rejects.
- **Budget:** measure CPU and outbound requests per run against Free's limits (decision 2).

### App and site
- Ask for notification permission when someone saves their first trip, not at launch.
- Per-trip alert switches on the trip card; a global switch in Account.
- Tapping a push opens that trip's train (deep link by trip id, resolved after sign-in).

**Tests:** `alerts.js` rules (threshold, cooldown, dedupe, service date, midnight and daylight-saving crossings); the
scheduled job against fixtures (unchanged feed → no event; one delay jump → one event; another user's trip → none);
token expiry. **Exit:** a simulated delay sends exactly one push to the right device; repeated runs send nothing.

## Phase 3: iOS Live Activities (about 1–2 weeks) — F03

- A widget extension target in `app/ios` with ActivityKit: attributes (train, route, your stops), state (status,
  delay, next stop, ETA, progress, report time). Lock Screen and Dynamic Island layouts; stale state when the
  report is old.
- A small Capacitor plugin in the app: `start`, `update`, `end`, and the activity's push token sent to the worker.
- The Phase 2 job also pushes activity updates (Apple's `liveactivity` push type) and ends the activity on arrival or
  cancellation. If Apple direct isn't workable from the Worker, Live Activities update only while the app is open
  until a relay exists; say so in the UI.
- Android: an ongoing trip notification instead.

**Exit:** on a physical iPhone, an activity starts from a trip, updates from a server push, shows stale data as
stale, and ends by itself. Devices without Live Activities fall back to notifications.

## Phase 4: engagement (about 3–4 weeks) — F04, F05, F06, F07, F08, F11

- **Journey timeline (F05):** the trip's `journey_events` in order, reported and inferred labelled differently.
  History starts when Phase 2 ships; earlier trips have none, and none is invented.
- **Arrival countdown (F04):** on Home and the Live Activity, "about 23 min (estimated)". No countdown on feeds that
  report too rarely to support it.
- **Passport (F06):** after a trip ends, ask "Did you ride this?" New `rode` column on `trips`. Stats from
  confirmed trips only: trips, miles (along the rail network the map already routes on, labelled approximate),
  railroads, states, longest ride, total delay. Export and delete.
- **Sharing (F07):** a revocable, expiring link per trip (`trip_shares` table, random token) showing train status
  and ETA at the rider's stop only. Optional push to friends for big changes, opt-in on both sides.
- **Station intelligence (F08):** on station boards, trains in the next hour and how many are 15+ minutes late,
  labelled "in the live feed" since coverage isn't complete.
- **Alerts with sources (F11):** decode GTFS-RT service alerts in `worker/src/gtfsrt.js` and NJT `getAlerts`; show
  the agency's text and time. Amtrak keeps Amtraker's notices (already shown).

## Phase 5: advanced (each is a go/no-go after a data check) — F09, F10, F12, F13

- **Calendar import (F09):** read events with permission, find "Amtrak 5" style entries, match against timetables,
  and ask before saving.
- **Connections (F10):** link two trips; buffer = ETA of the first at the transfer station → departure of the
  second − a transfer allowance. Shown as comfortable / tight / at risk.
- **Widgets (F13):** WidgetKit and an Android widget reading the same cached trip state; watch app after that.
- **Delay prediction:** only after months of Phase 2 history and a measured accuracy.
- **Equipment / inbound train (F12): blocked.** No feed reports which trainset runs which train. NJ Transit's
  timetable has `block_id`, but that's the plan, not what actually ran, so it doesn't qualify.

## Costs

| Item | Cost | Needed for |
|---|---|---|
| Apple Developer Program | $99/year | iOS push, Live Activities, App Store |
| Cloudflare Workers Paid | $5/month, if Free's limits are hit | The alert engine at scale |
| Firebase Cloud Messaging | Free | Android push; maybe iOS push |
| Everything else | Free | |

## Suggested first changes, in order

1. `app/` into a private repo.
2. Playwright smoke tests and CI.
3. Freshness helper and stale/offline labelling.
4. Phone tabs with Home hero (behind no flag; desktop untouched).
5. Train detail reordering.
6. Push-transport test (decides the rest of Phase 2).
