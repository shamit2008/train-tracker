#!/usr/bin/env node
// Downloads Metrolink's and Caltrain's static GTFS and boils them down to src/schedules.json:
// station names and positions, route names, and each trip's stops with scheduled times.
// The live feeds only carry trip and stop IDs, so the worker uses this to name and time them.
//
//   node build-schedules.mjs        (then redeploy: npx wrangler deploy)
//
// Rerun after either railroad publishes a new timetable. Reads CALTRAIN_511_KEY from ../.env or the
// environment (511 needs a token even for static data). The output holds public timetable data only.
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));

async function key(name) {
  if (process.env[name]) return process.env[name];
  try {
    const text = await readFile(path.join(dir, '..', '.env'), 'utf8');
    const m = text.match(new RegExp(`^\\s*${name}\\s*=\\s*(.*?)\\s*$`, 'm'));
    if (m) return m[1].replace(/^(['"])(.*)\1$/, '$2');
  } catch { /* no .env */ }
  return '';
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const head = rows.shift().map((h) => h.replace(/^﻿/, '').trim());
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}

const secs = (hms) => { const [h, m, s] = hms.split(':').map(Number); return h * 3600 + m * 60 + (s || 0); };
const round = (x) => Math.round(Number(x) * 1e5) / 1e5;

async function download(url, headers = {}) {
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok) throw new Error(`${url.replace(/api_key=[^&]+/, 'api_key=…')}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function readGtfs(zip) {
  const tmp = await mkdtemp(path.join(tmpdir(), 'gtfs-'));
  try {
    await writeFile(path.join(tmp, 'feed.zip'), zip);
    execFileSync('unzip', ['-oq', path.join(tmp, 'feed.zip'), '-d', tmp]);
    const read = async (f) => parseCsv(await readFile(path.join(tmp, f), 'utf8'));
    return { stops: await read('stops.txt'), routes: await read('routes.txt'), trips: await read('trips.txt'), stopTimes: await read('stop_times.txt') };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/* prefix: the operator's station-code prefix. routeName/stationName tidy the published names. */
function compact(g, { prefix, routeName, stationOf, stationName = (n) => n }) {
  const stations = {}, stops = {};
  const byId = new Map(g.stops.map((s) => [s.stop_id, s]));
  for (const s of g.stops) {
    const st = stationOf(s, byId);
    if (!st) continue;
    const code = prefix + st.stop_id;
    stops[s.stop_id] = code;
    stations[code] ||= [stationName(st.stop_name), round(st.stop_lat), round(st.stop_lon)];
  }
  const routes = Object.fromEntries(g.routes.map((r) => [r.route_id, routeName(r)]));
  const trips = {};
  for (const t of g.trips) trips[t.trip_id] = [t.route_id, t.trip_headsign || '', t.trip_short_name || t.trip_id, []];
  const sorted = g.stopTimes.slice().sort((a, b) => (a.trip_id < b.trip_id ? -1 : a.trip_id > b.trip_id ? 1 : a.stop_sequence - b.stop_sequence));
  for (const st of sorted) {
    const t = trips[st.trip_id];
    if (!t || !stops[st.stop_id]) continue;
    const arr = secs(st.arrival_time || st.departure_time), dep = secs(st.departure_time || st.arrival_time);
    t[3].push(arr === dep ? [st.stop_id, arr] : [st.stop_id, arr, dep]);
  }
  for (const id of Object.keys(trips)) if (trips[id][3].length < 2) delete trips[id];
  return { stations, stops, routes, trips };
}

const caltrainKey = await key('CALTRAIN_511_KEY');
if (!caltrainKey) { console.error('No CALTRAIN_511_KEY found in ../.env or the environment.'); process.exit(1); }

const [ml, ct] = await Promise.all([
  download('https://metrolinktrains.com/globalassets/about/gtfs/gtfs.zip').then(readGtfs),
  download(`https://api.511.org/transit/datafeeds?api_key=${encodeURIComponent(caltrainKey)}&operator_id=CT`).then(readGtfs),
]);

const out = {
  built: new Date().toISOString().slice(0, 10),
  Metrolink: compact(ml, {
    prefix: 'ML-',
    // "Metrolink Inland Empire-Orange County Line" reads better than the route_id "Inland Emp.-Orange Co. Line"
    routeName: (r) => (r.route_long_name || r.route_id).replace(/^Metrolink\s+/, ''),
    stationOf: (s) => s,
  }),
  Caltrain: compact(ct, {
    prefix: 'CT-',
    routeName: (r) => {
      const base = (r.route_short_name || r.route_id).replace(/\s+Week(day|end)$/i, '');
      return /south county/i.test(base) ? 'South County Connector' : 'Caltrain ' + base;
    },
    stationName: (n) => n.replace(/\s+(Caltrain\s+)?Station$/i, ''),
    // Caltrain lists each platform as its own stop; trains are shown at the parent station
    stationOf: (s, byId) => (s.location_type === '1' ? s : s.parent_station ? byId.get(s.parent_station) : s),
  }),
};

const file = path.join(dir, 'src', 'schedules.json');
await writeFile(file, JSON.stringify(out));
for (const op of ['Metrolink', 'Caltrain']) {
  const o = out[op];
  console.log(`${op}: ${Object.keys(o.stations).length} stations, ${Object.keys(o.routes).length} routes, ${Object.keys(o.trips).length} trips`);
}
console.log(`Wrote ${path.relative(process.cwd(), file)} (${Math.round(JSON.stringify(out).length / 1024)} KB)`);
