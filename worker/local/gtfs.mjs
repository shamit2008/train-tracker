/* Reading static GTFS feeds (zipped CSV timetables) in Node, for the build scripts. Needs the `unzip` command. */
import { readFile, writeFile, mkdtemp, rm, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function parseCsv(text) {
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
  if (!rows.length) return [];
  const head = rows.shift().map((h) => h.replace(/^﻿/, '').trim());
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}

/* GTFS times are hours:minutes:seconds after "noon minus 12 hours" on the service day, and can pass 24:00. */
export const secs = (hms) => { const [h, m, s] = hms.split(':').map(Number); return h * 3600 + m * 60 + (s || 0); };

export async function download(url, headers = {}) {
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok) throw new Error(`${url.replace(/api_key=[^&]+/, 'api_key=…')}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/* One CSV line into fields (GTFS rows never span lines in practice). */
function splitLine(line) {
  if (!line.includes('"')) return line.split(',');
  const out = [];
  let field = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(field); field = ''; }
    else field += c;
  }
  out.push(field);
  return out;
}

/* Streams a table line by line, keeping only the rows `keep` accepts: for tables too big to hold whole
   (MBTA's stop_times.txt is 150 MB, nearly all buses and subway). */
async function readFiltered(file, keep) {
  const rows = [];
  let head = null;
  for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
    if (!line) continue;
    const cells = splitLine(line);
    if (!head) { head = cells.map((h) => h.replace(/^\uFEFF/, '').trim()); continue; }
    const row = Object.fromEntries(head.map((h, i) => [h, (cells[i] ?? '').trim()]));
    if (keep(row)) rows.push(row);
  }
  return rows;
}

/* Unzips a feed and parses its tables, skipping shapes.txt (route geometry: large, and not needed here).
   Missing optional tables (calendar_dates.txt, say) come back as empty arrays.
     inner        a zip inside the zip that holds the feed
     keep(table, g)  may return a row filter for a table, given the tables read so far (in the order below) */
const TABLES = ['agency', 'feed_info', 'stops', 'routes', 'trips', 'stop_times', 'calendar', 'calendar_dates'];
export async function readGtfs(zip, { inner, keep } = {}) {
  const tmp = await mkdtemp(path.join(tmpdir(), 'gtfs-'));
  try {
    await writeFile(path.join(tmp, 'feed.zip'), zip);
    let feed = path.join(tmp, 'feed.zip');
    if (inner) {
      execFileSync('unzip', ['-oq', feed, inner, '-d', path.join(tmp, 'outer')]);
      feed = path.join(tmp, 'outer', inner);
    }
    // exit status 11 only means some optional table isn't in this feed
    const un = spawnSync('unzip', ['-oq', feed, ...TABLES.map((t) => t + '.txt'), '-d', path.join(tmp, 'feed')], { stdio: 'ignore' });
    if (un.status !== 0 && un.status !== 11) throw new Error(`unzip failed (status ${un.status})`);
    const files = new Set(await readdir(path.join(tmp, 'feed')));
    const g = {};
    for (const t of TABLES) {
      const file = path.join(tmp, 'feed', t + '.txt');
      const filter = keep && keep(t, g);
      g[t] = !files.has(t + '.txt') ? [] : filter ? await readFiltered(file, filter) : parseCsv(await readFile(file, 'utf8'));
    }
    return g;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/* A readGtfs `keep` that loads only the routes keepRoute accepts, their trips, their stop times and their
   calendar exceptions. */
export const onlyRoutes = (keepRoute) => (table, g) => {
  if (table === 'trips') { const ids = new Set(g.routes.filter(keepRoute).map((r) => r.route_id)); return (t) => ids.has(t.route_id); }
  if (table === 'stop_times') { const ids = new Set(g.trips.map((t) => t.trip_id)); return (st) => ids.has(st.trip_id); }
  if (table === 'calendar_dates') { const ids = new Set(g.trips.map((t) => t.service_id)); return (d) => ids.has(d.service_id); }
  return null;
};

/* Downloads the first of several URLs that works. */
export async function downloadFirst(urls, headers) {
  let last;
  for (const url of [].concat(urls)) {
    try { return await download(url, headers); } catch (err) { last = err; }
  }
  throw last;
}

/* Reads a key from the environment or ../.env (relative to the worker folder). */
export async function envKey(name, workerDir) {
  if (process.env[name]) return process.env[name];
  try {
    const text = await readFile(path.join(workerDir, '..', '.env'), 'utf8');
    const m = text.match(new RegExp(`^\\s*${name}\\s*=\\s*(.*?)\\s*$`, 'm'));
    if (m) return m[1].replace(/^(['"])(.*)\1$/, '$2');
  } catch { /* no .env */ }
  return '';
}
