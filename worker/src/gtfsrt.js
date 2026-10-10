/* A small GTFS-Realtime decoder: just the fields Trackside reads from VehiclePositions and TripUpdates.
   Field numbers follow https://gtfs.org/realtime/reference/ (gtfs-realtime.proto). */

function reader(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = 0;
  // Varints come back as { lo, num }: lo is the low 32 bits (for int32 fields, which may be negative),
  // num the full value as a Number (exact up to 2^53, plenty for timestamps).
  const varint = () => {
    let lo = 0, num = 0, shift = 0, b;
    do {
      if (pos >= buf.length) throw new Error('truncated varint');
      b = buf[pos++];
      if (shift < 32) lo |= (b & 0x7f) << shift;
      num += (b & 0x7f) * 2 ** shift;
      shift += 7;
    } while (b & 0x80);
    return { lo: lo | 0, num };
  };
  return {
    done: () => pos >= buf.length,
    /* Yields [field, wireType, value]: value is a varint, a float (fixed32), a double (fixed64) or bytes. */
    *fields() {
      while (pos < buf.length) {
        const key = varint().num, f = Math.floor(key / 8), wt = key & 7;
        if (wt === 0) yield [f, wt, varint()];
        else if (wt === 1) { const v = view.getFloat64(pos, true); pos += 8; yield [f, wt, v]; }
        else if (wt === 2) { const n = varint().num; const v = buf.subarray(pos, pos + n); pos += n; yield [f, wt, v]; }
        else if (wt === 5) { const v = view.getFloat32(pos, true); pos += 4; yield [f, wt, v]; }
        else throw new Error('unsupported wire type ' + wt);
      }
    },
  };
}

const text = (b) => new TextDecoder().decode(b);

function message(buf, spec) {
  const out = {};
  for (const [f, , v] of reader(buf).fields()) {
    const s = spec[f];
    if (!s) continue;
    const [name, kind, sub, repeated] = s;
    const val = kind === 'msg' ? message(v, sub)
      : kind === 'str' ? text(v)
      : kind === 'u' ? v.num
      : kind === 'i32' ? v.lo
      : v;   // float / double
    if (repeated) (out[name] ||= []).push(val); else out[name] = val;
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

export function decodeFeed(bytes) {
  const feed = message(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), FEED);
  return { header: feed.header || {}, entities: (feed.entities || []).filter((e) => !e.deleted) };
}
