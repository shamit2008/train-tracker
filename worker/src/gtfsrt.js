/* A small GTFS-Realtime decoder: just the fields Trackside reads from VehiclePositions and TripUpdates.
   Field numbers follow https://gtfs.org/realtime/reference/ (gtfs-realtime.proto). */

/* Decodes one message from buf[start, end) by its spec: { field: [name, kind, subSpec, repeated] }, where kind is
   'msg', 'str', 'u' (unsigned varint), 'i32' (signed int32), 'f' (float or double) or 'raw' (the bytes).
   A plain loop, not a generator: feeds run to hundreds of kilobytes and Workers bill CPU time. */
const utf8 = new TextDecoder();
function message(buf, spec, start = 0, end = buf.length) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out = {};
  let pos = start, lo = 0;
  // A varint as a Number (exact up to 2^53, plenty for timestamps); its low 32 bits are left in `lo`, for int32
  // fields, whose negatives arrive as 10-byte varints too big for a Number to hold exactly.
  const varint = () => {
    let num = 0, mul = 1, shift = 0, b;
    lo = 0;
    do {
      if (pos >= end) throw new Error('truncated varint');
      b = buf[pos++];
      if (shift < 32) lo |= (b & 0x7f) << shift;
      num += (b & 0x7f) * mul;
      mul *= 128; shift += 7;
    } while (b & 0x80);
    return num;
  };
  while (pos < end) {
    const key = varint(), f = Math.floor(key / 8), wt = key & 7;
    const s = spec[f];
    let val;
    if (wt === 0) {
      const n = varint();
      if (!s) continue;
      val = s[1] === 'i32' ? lo | 0 : n;
    } else if (wt === 2) {
      const n = varint(), from = pos;
      pos += n;
      if (pos > end) throw new Error('truncated field');
      if (!s) continue;
      val = s[1] === 'msg' ? message(buf, s[2], from, pos) : s[1] === 'str' ? utf8.decode(buf.subarray(from, pos)) : buf.subarray(from, pos);
    } else if (wt === 1) {
      if (pos + 8 > end) throw new Error('truncated field');
      val = view.getFloat64(pos, true); pos += 8;
      if (!s) continue;
    } else if (wt === 5) {
      if (pos + 4 > end) throw new Error('truncated field');
      val = view.getFloat32(pos, true); pos += 4;
      if (!s) continue;
    } else throw new Error('unsupported wire type ' + wt);
    if (s[3]) (out[s[0]] ||= []).push(val); else out[s[0]] = val;
  }
  return out;
}

const TRIP = { 1: ['tripId', 'str'], 2: ['startTime', 'str'], 3: ['startDate', 'str'], 4: ['scheduleRelationship', 'u'], 5: ['routeId', 'str'], 6: ['directionId', 'u'] };
const VEHICLE_DESC = { 1: ['id', 'str'], 2: ['label', 'str'] };
const POSITION = { 1: ['lat', 'f'], 2: ['lon', 'f'], 3: ['bearing', 'f'], 5: ['speed', 'f'] };
const VEHICLE = {
  1: ['trip', 'msg', TRIP], 2: ['position', 'msg', POSITION], 3: ['stopSeq', 'u'], 4: ['status', 'u'],
  5: ['timestamp', 'u'], 7: ['stopId', 'str'], 8: ['vehicle', 'msg', VEHICLE_DESC],
};
const STOP_EVENT = { 1: ['delay', 'i32'], 2: ['time', 'u'] };
const STOP_UPDATE = { 1: ['stopSeq', 'u'], 2: ['arrival', 'msg', STOP_EVENT], 3: ['departure', 'msg', STOP_EVENT], 4: ['stopId', 'str'], 5: ['scheduleRelationship', 'u'] };
const TRIP_UPDATE = { 1: ['trip', 'msg', TRIP], 2: ['stops', 'msg', STOP_UPDATE, true], 3: ['vehicle', 'msg', VEHICLE_DESC], 4: ['timestamp', 'u'], 5: ['delay', 'i32'] };
const ENTITY = { 1: ['id', 'str'], 2: ['deleted', 'u'], 3: ['tripUpdate', 'msg', TRIP_UPDATE], 4: ['vehicle', 'msg', VEHICLE] };
const HEADER = { 1: ['version', 'str'], 3: ['timestamp', 'u'] };
const FEED = { 1: ['header', 'msg', HEADER], 2: ['entities', 'msg', ENTITY, true] };

/* VehiclePosition.current_status */
export const STATUS = { INCOMING_AT: 0, STOPPED_AT: 1, IN_TRANSIT_TO: 2 };
/* TripDescriptor / StopTimeUpdate schedule_relationship */
export const CANCELED = 3;
export const SKIPPED = 1;

/* keep(trip, entityId), if given, picks the entities worth decoding in full from their trip alone, so a feed
   that is mostly buses (MBTA's, RTD's) costs little more than its trains. */
const RAW_ENTITY = { 1: ['id', 'str'], 2: ['deleted', 'u'], 3: ['tripUpdate', 'raw'], 4: ['vehicle', 'raw'] };
const RAW_FEED = { 1: ['header', 'msg', HEADER], 2: ['entities', 'msg', RAW_ENTITY, true] };
const TRIP_ONLY = { 1: ['trip', 'msg', TRIP] };

export function decodeFeed(bytes, keep) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!keep) {
    const feed = message(buf, FEED);
    return { header: feed.header || {}, entities: (feed.entities || []).filter((e) => !e.deleted) };
  }
  const feed = message(buf, RAW_FEED), entities = [];
  for (const e of feed.entities || []) {
    if (e.deleted) continue;
    const out = { id: e.id };
    for (const [name, spec] of [['tripUpdate', TRIP_UPDATE], ['vehicle', VEHICLE]]) {
      if (e[name] && keep(message(e[name], TRIP_ONLY).trip || {}, e.id)) out[name] = message(e[name], spec);
    }
    if (out.tripUpdate || out.vehicle) entities.push(out);
  }
  return { header: feed.header || {}, entities };
}
