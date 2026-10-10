# Trackside feeds worker

Metrolink and Caltrain publish live positions through key-protected GTFS-Realtime feeds. The keys can't go in
`index.html`: GitHub Pages serves that file to everyone. This Cloudflare Worker holds the keys as secrets,
polls the feeds, and serves the trains to the site as plain JSON.

```text
Metrolink GTFS-RT ─┐
                   ├─ this worker (keys as secrets, shared cache) ─ /v1/trains, /v1/stations ─ index.html
511 Caltrain RT  ──┘
```

## Where the keys live

| Place | Keys? | Committed? |
|---|---|---|
| `../.env` | Yes, on your computer | No (git-ignored, and blocked by the pre-commit hook) |
| Cloudflare Worker secrets | Yes | No (stored by Cloudflare) |
| `index.html`, `worker/src/*` | No, only the worker's URL | Yes |

Two checks stop a key from being published by mistake:

- `../deploy.mjs` refuses to upload any file that contains a key.
- `../.githooks/pre-commit` refuses commits that contain a key or a `.env` file. Turn it on in each clone with `git config core.hooksPath .githooks`.

## Deploy

```bash
cd worker
npm install
npx wrangler login   # once; opens a browser to sign in to Cloudflare (the free plan is enough)
npm run deploy       # deploys, stores both keys as secrets, writes the worker URL into ../index.html
```

Then publish the site as usual. Metrolink and Caltrain show up as filter chips under Explore. Like Brightline
and VIA Rail, they start switched off.

To change a key later, update `../.env` and run `npm run deploy` again.

## Try it locally

```bash
npm run dev          # serves the worker on http://localhost:8787 using the keys in ../.env
```

A copy of `index.html` opened from disk or `localhost` uses this local server automatically until
`FEEDS_WORKER` is set.

## Timetables

The live feeds carry only trip and stop IDs. `src/schedules.json` maps them to route names, stations and
scheduled times. It's built from each railroad's static GTFS and holds only public timetable data. Rebuild
it whenever Metrolink or Caltrain publishes a new timetable, then redeploy:

```bash
npm run schedules && npm run deploy
```

If a trip isn't in the bundle, its train still appears at its reported position, but without its stops.

## Limits

- 511 allows 60 requests an hour per token. The worker reuses Caltrain vehicle positions for 2 minutes and
  trip updates for 4 minutes, which comes to about 45 requests an hour per Cloudflare location. If 511 refuses
  a request, the last good copy is served for up to 30 minutes.
- Metrolink is reused for 30 seconds, matching its update rate.
- `ALLOWED_ORIGINS` in `wrangler.toml` lists the pages that may read the worker from a browser.
