#!/usr/bin/env node
// Downloads the static GTFS of every railroad in src/agencies.js and boils it down to src/schedules.json:
// station names and positions, line names, and each train's stops with scheduled times.
// The live feeds only carry trip and stop IDs, so the worker uses this to name and time them.
//
//   node build-schedules.mjs        (or: npm run schedules; then redeploy)
//
// Rerun after a railroad publishes a new timetable. A download that needs a key (Caltrain's, from 511) reads it
// from ../.env or the environment. If a railroad fails, its previous schedule is kept. The output holds public
// timetable data only.
//
// Output, per railroad id:
//   { tz, stations: { code: [name, lat, lon] }, stops: { stop_id: code }, routes: { route_id: name },
//     runs: [[route_id, headsign, number, [[stop_id, arrive, depart?], …], [stop_sequence, …]?]],
//     trips: { trip_id: run index }, nums: { number: [run index, …] } }
// Times are seconds after "noon minus 12 hours" on the service day. Trips with identical stops and times (the
// same train on different service calendars) share one run. stop_sequence is only listed when it isn't 1, 2, 3….
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { secs, downloadFirst, readGtfs, envKey, onlyRoutes } from './local/gtfs.mjs';
import { AGENCIES } from './src/agencies.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(dir, 'src', 'schedules.json');
const round = (x) => Math.round(Number(x) * 1e5) / 1e5;
const isRail = (r) => r.route_type === '2';
/* "Southbound to Miami Airport" -> "Miami Airport"; "BALTIMORE" -> "Baltimore" */
const headsign = (h = '') => {
  const s = h.replace(/^(north|south|east|west)bound\s+to\s+/i, '').trim();
  return s === s.toUpperCase() ? s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()) : s;
};

function compact(g, a) {
  const o = a.gtfs;
  const keepRoute = o.keepRoute || isRail;
  const tz = (g.agency[0] && g.agency[0].agency_timezone) || 'America/New_York';
  const byId = new Map(g.stops.map((s) => [s.stop_id, s]));
  // platforms are shown at their station
  const stationOf = (s) => (s.parent_station && byId.has(s.parent_station) ? byId.get(s.parent_station) : s);

  const routes = {}, routeRow = new Map(g.routes.map((r) => [r.route_id, r]));
  for (const r of g.routes) if (keepRoute(r)) routes[r.route_id] = (o.routeName ? o.routeName(r) : (r.route_long_name || r.route_short_name || r.route_id)).trim();

  const stations = {}, stops = {};
  const codeFor = (stopId) => {
    if (stopId in stops) return stops[stopId];
    const raw = byId.get(stopId);
    if (!raw) return (stops[stopId] = null);
    const st = stationOf(raw);
    const code = a.id + '-' + st.stop_id;
    stations[code] ||= [(o.stationName ? o.stationName(st.stop_name) : st.stop_name).trim(), round(st.stop_lat), round(st.stop_lon)];
    return (stops[stopId] = code);
  };

  const timesByTrip = new Map();
  for (const st of g.stop_times) {
    if (!timesByTrip.has(st.trip_id)) timesByTrip.set(st.trip_id, []);
    timesByTrip.get(st.trip_id).push(st);
  }

  const runs = [], runIdx = new Map(), trips = {}, nums = {};
  for (const t of g.trips) {
    if (!(t.route_id in routes)) continue;
    const times = (timesByTrip.get(t.trip_id) || []).sort((x, y) => x.stop_sequence - y.stop_sequence);
    const list = [], seqs = [];
    for (const st of times) {
      if (!codeFor(st.stop_id)) continue;
      const arr = secs(st.arrival_time || st.departure_time), dep = secs(st.departure_time || st.arrival_time);
      list.push(arr === dep ? [st.stop_id, arr] : [st.stop_id, arr, dep]);
      seqs.push(Number(st.stop_sequence));
    }
    if (list.length < 2) continue;
    const num = String(o.num ? o.num(t, { route: routeRow.get(t.route_id), dep: list[0][2] ?? list[0][1] }) : t.trip_short_name || t.trip_id).trim();
    const run = [t.route_id, headsign(t.trip_headsign), num, list];
    if (seqs.some((s, i) => s !== i + 1)) run.push(seqs);
    const key = JSON.stringify(run);
    if (!runIdx.has(key)) { runIdx.set(key, runs.length); runs.push(run); (nums[num] ||= []).push(runs.length - 1); }
    if (a.joinBy !== 'entity') trips[t.trip_id] = runIdx.get(key);   // matched by train number instead
  }
  // only the stops trains use
  for (const id of Object.keys(stops)) if (!stops[id]) delete stops[id];
  return { tz, stations, stops, routes, runs, trips, nums };
}

let previous = {};
try { previous = JSON.parse(await readFile(OUT, 'utf8')); } catch { /* first run */ }

const out = { built: new Date().toISOString().slice(0, 10) };
let failures = 0;
for (const a of AGENCIES) {
  try {
    let url = a.gtfs.url;
    if (typeof url === 'function') {
      const key = await envKey(a.key, dir);
      if (!key) throw new Error(`no ${a.key} in ../.env or the environment`);
      url = url(key);
    }
    const g = await readGtfs(await downloadFirst(url), { inner: a.gtfs.inner, keep: onlyRoutes(a.gtfs.keepRoute || isRail) });
    const s = compact(g, a);
    if (!s.runs.length) throw new Error('no trains in the timetable');
    out[a.id] = s;
    console.log(`${a.provider}: ${Object.keys(s.stations).length} stations, ${Object.keys(s.routes).length} lines, ${s.runs.length} runs, ${Math.round(JSON.stringify(s).length / 1024)} KB`);
  } catch (err) {
    failures++;
    if (previous[a.id]) { out[a.id] = previous[a.id]; console.warn(`${a.provider}: ${err.message.replace(/api_key=[^&\s]+/, 'api_key=…')}. Kept the previous schedule.`); }
    else console.warn(`${a.provider}: ${err.message.replace(/api_key=[^&\s]+/, 'api_key=…')}. Left out.`);
  }
}

await writeFile(OUT, JSON.stringify(out));
console.log(`Wrote ${path.relative(process.cwd(), OUT)} (${Math.round(JSON.stringify(out).length / 1024)} KB)`);
if (failures) process.exitCode = 2;
