/* Trackside feeds: a Cloudflare Worker that holds the Metrolink and Caltrain (511) API keys, polls their
   GTFS-Realtime feeds, and serves the trains as JSON shaped like the Amtraker API, so the site can treat
   them like any other operator. The keys live only in this worker's secrets; nothing it returns contains them.

   GET /v1/trains    { Metrolink: [train…], Caltrain: [train…] }
   GET /v1/stations  { code: { code, name, label, city, state, lat, lon } }
*/
import { decodeFeed, STATUS, CANCELED, SKIPPED } from './gtfsrt.js';
import SCHEDULES from './schedules.json' with { type: 'json' };

const TZ = 'America/Los_Angeles';
const MPS_TO_MPH = 2.236936;

/* How long each upstream feed is reused. 511 allows 60 requests an hour per token, shared by both Caltrain
   feeds, so they're polled gently (30 + 15 an hour per Cloudflare location). */
const FEEDS = {
  Metrolink: {
    vehicles: { url: 'https://metrolink-gtfsrt.gbsdigital.us/feed/gtfsrt-vehicles', fresh: 30 },
    trips: { url: 'https://metrolink-gtfsrt.gbsdigital.us/feed/gtfsrt-trips', fresh: 30 },
    auth: (env) => ({ headers: { 'X-Api-Key': env.METROLINK_API_KEY } }),
    hasKey: (env) => !!env.METROLINK_API_KEY,
  },
  Caltrain: {
    vehicles: { url: 'https://api.511.org/transit/vehiclepositions?agency=CT', fresh: 120 },
    trips: { url: 'https://api.511.org/transit/tripupdates?agency=CT', fresh: 240 },
    auth: (env, url) => ({ url: url + '&api_key=' + encodeURIComponent(env.CALTRAIN_511_KEY) }),
    hasKey: (env) => !!env.CALTRAIN_511_KEY,
  },
};
const KEEP_STALE = 30 * 60;   // after an upstream error, keep serving the last good copy this long (seconds)

/* ---------------- upstream fetch with a shared cache ---------------- */
// The cache key is the URL without the key, so the key is never stored or logged as part of it.
const memo = new Map();   // fallback for runtimes without the Cache API (local dev)
async function cached(name, { url, fresh }, auth, env, ctx) {
  const cacheKey = new Request('https://trackside-feeds.internal/' + encodeURIComponent(name + ' ' + url));
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const hit = cache ? await cache.match(cacheKey) : memo.get(cacheKey.url);
  const fetchedAt = hit ? Number(hit.headers.get('x-fetched-at')) : 0;
  const age = (Date.now() - fetchedAt) / 1000;
  if (hit && age < fresh) return { bytes: new Uint8Array(await hit.clone().arrayBuffer()), age };

  try {
    const a = auth(env, url);
    const res = await fetch(a.url || url, { headers: a.headers || {}, cf: { cacheTtl: 0 } });
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    decodeFeed(bytes);   // don't cache something that isn't a feed (an HTML error page, say)
    const store = new Response(bytes, { headers: { 'x-fetched-at': String(Date.now()), 'cache-control': `max-age=${KEEP_STALE}` } });
    if (cache) ctx.waitUntil(cache.put(cacheKey, store));
    else memo.set(cacheKey.url, store);
    return { bytes, age: 0 };
  } catch (err) {
    if (hit && age < KEEP_STALE) return { bytes: new Uint8Array(await hit.clone().arrayBuffer()), age, error: err.message };
    throw err;
  }
}

/* ---------------- time helpers (service days are Pacific time) ---------------- */
const dtf = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
function parts(ms) {
  const p = Object.fromEntries(dtf.formatToParts(ms).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}
const offsetMin = (ms) => { const p = parts(ms); return Math.round((Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - ms) / 60000); };
/* GTFS times count from "noon minus 12 hours" on the service day, which handles daylight-saving days correctly. */
function serviceBase(yyyymmdd) {
  const y = +yyyymmdd.slice(0, 4), m = +yyyymmdd.slice(4, 6), d = +yyyymmdd.slice(6, 8);
  const noonUtc = Date.UTC(y, m - 1, d, 12);
  const noon = noonUtc - offsetMin(noonUtc) * 60000;
  return noon - 12 * 3600000;
}
const ymd = (ms) => { const p = parts(ms); return `${p.y}${String(p.m).padStart(2, '0')}${String(p.d).padStart(2, '0')}`; };
function iso(ms) {
  if (ms == null || !isFinite(ms)) return '';
  const off = offsetMin(ms);
  const sign = off < 0 ? '-' : '+', a = Math.abs(off);
  return new Date(ms + off * 60000).toISOString().slice(0, 19) + sign + String(Math.floor(a / 60)).padStart(2, '0') + ':' + String(a % 60).padStart(2, '0');
}

const kmBetween = (a, b) => {
  const r = Math.PI / 180, dLat = (b[0] - a[0]) * r, dLon = (b[1] - a[1]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
};

const HEADINGS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const compass = (deg) => (deg == null || !isFinite(deg) ? '' : HEADINGS[Math.round((((deg % 360) + 360) % 360) / 45) % 8]);

/* ---------------- one operator's feeds -> Amtraker-shaped trains ---------------- */
function buildTrains(op, vehiclesFeed, tripsFeed, now) {
  const sched = SCHEDULES[op];
  const updates = new Map(), vehicles = new Map();
  for (const e of tripsFeed.entities) if (e.tripUpdate && e.tripUpdate.trip && e.tripUpdate.trip.tripId) updates.set(e.tripUpdate.trip.tripId, e.tripUpdate);
  for (const e of vehiclesFeed.entities) if (e.vehicle && e.vehicle.trip && e.vehicle.trip.tripId) vehicles.set(e.vehicle.trip.tripId, e.vehicle);

  const out = [];
  for (const tripId of new Set([...vehicles.keys(), ...updates.keys()])) {
    const veh = vehicles.get(tripId), tu = updates.get(tripId);
    const desc = (veh && veh.trip) || tu.trip;
    const st = sched.trips[tripId];
    const routeId = desc.routeId || (st && st[0]) || '';
    const num = st ? st[2] : (veh && veh.vehicle && veh.vehicle.label) || tripId;

    // live predictions by stop: { arr, dep } in ms
    const pred = new Map();
    for (const u of (tu && tu.stops) || []) {
      if (u.scheduleRelationship === SKIPPED) { pred.set(u.stopId, { skipped: true }); continue; }
      const at = (ev) => (ev && ev.time ? ev.time * 1000 : null);
      pred.set(u.stopId, { arr: at(u.arrival) ?? at(u.departure), dep: at(u.departure) ?? at(u.arrival), delay: (u.departure || u.arrival || {}).delay });
    }

    let stations = [];
    if (st) {
      // Which service day: the feed's start date, or (Caltrain sends none) the day whose timetable best fits the predictions
      let base;
      if (desc.startDate) base = serviceBase(desc.startDate);
      else {
        const candidates = [serviceBase(ymd(now)), serviceBase(ymd(now - 86400000))];
        const anchor = st[3].find((s) => pred.get(s[0]) && pred.get(s[0]).arr);
        base = anchor
          ? candidates.reduce((b, c) => (Math.abs(pred.get(anchor[0]).arr - (c + anchor[1] * 1000)) < Math.abs(pred.get(anchor[0]).arr - (b + anchor[1] * 1000)) ? c : b))
          : candidates[0];
      }
      // The first stop with a prediction; stops before it have already been served (Caltrain only lists stops ahead)
      const firstPred = st[3].findIndex((s) => pred.has(s[0]));
      let delay = null;   // carried forward to stops without their own prediction
      stations = st[3].map(([stopId, arrS, depS = arrS], i) => {
        const schArr = base + arrS * 1000, schDep = base + depS * 1000;
        const p = pred.get(stopId);
        let arr = null, dep = null;
        if (p && !p.skipped) {
          arr = p.arr; dep = p.dep;
          delay = dep != null ? dep - schDep : arr != null ? arr - schArr : delay;
        } else if (delay != null && (firstPred < 0 || i > firstPred)) {
          arr = schArr + delay; dep = schDep + delay;
        }
        const code = sched.stops[stopId];
        const info = sched.stations[code] || [stopId];
        return {
          name: info[0], code, tz: TZ, bus: false,
          schArr: iso(schArr), schDep: iso(schDep), arr: iso(arr), dep: iso(dep),
          arrCmnt: '', depCmnt: '', platform: '',
          _passed: firstPred > 0 && i < firstPred && !pred.has(stopId),
          _arr: arr ?? schArr, _dep: dep ?? schDep, _skipped: !!(p && p.skipped),
        };
      });

      // status: Departed for stops behind the train, Station for the stop it's standing at, Enroute for the rest
      let last = -1;
      stations.forEach((s, i) => { if (s._passed || s._dep <= now) last = i; });
      if (veh && veh.stopId && veh.status != null) {
        const vi = stations.findIndex((s, i) => sched.stops[veh.stopId] === s.code && i >= last);
        if (vi >= 0) last = veh.status === STATUS.STOPPED_AT ? vi - 1 : Math.max(last, vi - 1);
      }
      stations.forEach((s, i) => {
        s.status = i <= last ? 'Departed' : i === last + 1 && s._arr <= now && !s._skipped ? 'Station' : 'Enroute';
        delete s._passed; delete s._arr; delete s._dep; delete s._skipped;
      });
      stations = stations.filter((s) => s.code);
    }

    const first = stations[0], lastStop = stations[stations.length - 1];
    const allDeparted = stations.length && stations.every((s) => s.status === 'Departed');
    const notStarted = stations.length && stations.every((s) => s.status === 'Enroute') && Date.parse(first.dep || first.schDep) > now;
    if (allDeparted && !veh) continue;   // finished; the feed hasn't dropped it yet

    const pos = veh && veh.position;
    const posTs = veh && veh.timestamp ? veh.timestamp * 1000 : null;
    // Caltrain sends no speed. Estimate it from the distance to the next stop and the predicted arrival there,
    // so the train keeps moving on the map between updates (the site never runs it past that stop).
    let mph = pos && pos.speed != null ? pos.speed * MPS_TO_MPH : null;
    const next = stations.find((s) => s.status !== 'Departed');
    if (mph == null && pos && next && next.status === 'Enroute' && stations.some((s) => s.status === 'Departed')) {
      const at = sched.stations[next.code], eta = Date.parse(next.arr || next.schArr), from = posTs ?? now;
      if (at && eta - from > 20000) mph = Math.min(79, kmBetween([pos.lat, pos.lon], [at[1], at[2]]) / ((eta - from) / 3600000) * 0.621371);
    }
    const cancelled = desc.scheduleRelationship === CANCELED;
    out.push({
      dataSource: 'trackside-feeds',
      provider: op,
      routeName: sched.routes[routeId] || routeId || op,
      trainNum: String(num),
      trainNumRaw: String(num),
      trainID: `${num}-${op === 'Metrolink' ? 'ML' : 'CT'}`,
      lat: pos ? pos.lat : null,
      lon: pos ? pos.lon : null,
      heading: compass(pos && pos.bearing),
      velocity: mph ?? 0,
      trainState: cancelled ? 'Cancelled' : allDeparted ? 'Completed' : notStarted ? 'Predeparture' : 'Active',
      origCode: first ? first.code : '', origName: first ? first.name : '', originTZ: TZ,
      destCode: lastStop ? lastStop.code : '', destName: (st && st[1]) || (lastStop ? lastStop.name : ''), destTZ: TZ,
      lastValTS: iso(posTs ?? (tu && tu.timestamp ? tu.timestamp * 1000 : now)),
      stations,
      alerts: [],
    });
  }
  return out;
}

function stationList() {
  const out = {};
  for (const op of Object.keys(FEEDS)) {
    for (const [code, [name, lat, lon]] of Object.entries(SCHEDULES[op].stations)) {
      out[code] = { code, name, label: op, city: '', state: 'CA', lat, lon };
    }
  }
  return out;
}

/* ---------------- HTTP ---------------- */
/* Error text is passed to the page, so blank out the keys in case an error message ever echoes a URL. */
function scrub(msg, env) {
  let s = String(msg || 'error');
  for (const k of [env.METROLINK_API_KEY, env.CALTRAIN_511_KEY]) if (k) s = s.split(k).join('…');
  return s.replace(/api_key=[^&\s]+/gi, 'api_key=…');
}
function corsHeaders(req, env) {
  const origin = req.headers.get('Origin');
  const allowed = String(env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean);
  const ok = allowed.includes('*') || (origin && allowed.includes(origin)) || (origin && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
  return ok && origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : allowed.includes('*') ? { 'Access-Control-Allow-Origin': '*' } : {};
}
const json = (body, req, env, extra = {}) => new Response(JSON.stringify(body), {
  headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(req, env), ...extra },
});

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: { ...corsHeaders(req, env), 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '86400' } });
    if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });

    if (url.pathname === '/v1/stations') {
      return json(stationList(), req, env, { 'Cache-Control': 'public, max-age=86400' });
    }
    if (url.pathname === '/v1/trains') {
      const now = Date.now();
      const result = {}, status = {};
      await Promise.all(Object.entries(FEEDS).map(async ([op, f]) => {
        if (!f.hasKey(env)) { result[op] = []; status[op] = 'no key configured'; return; }
        try {
          const [v, t] = await Promise.all([cached(op + ' vehicles', f.vehicles, f.auth, env, ctx), cached(op + ' trips', f.trips, f.auth, env, ctx)]);
          result[op] = buildTrains(op, decodeFeed(v.bytes), decodeFeed(t.bytes), now);
          status[op] = v.error || t.error ? 'stale: ' + scrub(v.error || t.error, env) : 'ok';
        } catch (err) {
          result[op] = [];
          status[op] = 'error: ' + scrub(err.message, env);
        }
      }));
      // feed health goes in a header so the body stays shaped like Amtraker's (an object of train arrays)
      return json(result, req, env, { 'Cache-Control': 'public, max-age=15', 'X-Feed-Status': JSON.stringify(status), 'Access-Control-Expose-Headers': 'X-Feed-Status' });
    }
    if (url.pathname === '/') return new Response('Trackside feeds. See /v1/trains and /v1/stations.', { headers: { 'Content-Type': 'text/plain' } });
    return new Response('Not found', { status: 404 });
  },
};
