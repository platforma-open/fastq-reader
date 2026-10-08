// Minimal reader for ABIF (.ab1) Sanger chromatogram files.
//
// ABIF is a big-endian tagged container: a 128-byte header whose root entry
// points at a directory of 28-byte entries, each naming a tag (4 chars + a
// number) and where its data lives. Payloads of 4 bytes or less are stored
// inline in the entry's offset field. Only the tags a viewer needs are read —
// base calls, qualities, peak positions and the four analyzed dye traces.
// Format reference: Applied Biosystems "ABIF File Format" specification.

export type Ab1Base = "A" | "C" | "G" | "T";

export type Ab1Trace = {
  /** Base calls (edited calls `PBAS2` when present, else the original `PBAS1`). */
  sequence: string;
  /** Per-base Phred quality, same length as `sequence`. Empty if the file has none. */
  quality: number[];
  /** Scan index of each base call's peak, same length as `sequence`. */
  peaks: number[];
  /** Analyzed dye intensities per base, all of equal length (number of scans). */
  traces: Record<Ab1Base, Int16Array>;
  /** Number of scans in each trace. */
  scanCount: number;
  /** Free-form run metadata — sample name, instrument, run date, basecaller. */
  meta: { label: string; value: string }[];
};

type DirEntry = {
  /** Tag name and number, e.g. "PBAS2" — for error messages. */
  tag: string;
  elementType: number;
  elementSize: number;
  numElements: number;
  dataSize: number;
  dataOffset: number;
  /** Absolute byte offset of the entry itself — inline payloads live at +20. */
  entryOffset: number;
};

const ROOT_ENTRY_OFFSET = 6;
const ENTRY_SIZE = 28;

export class Ab1ParseError extends Error {}

function readDirectory(view: DataView): Map<string, DirEntry> {
  if (view.byteLength < ROOT_ENTRY_OFFSET + ENTRY_SIZE)
    throw new Ab1ParseError("File is too short to be an AB1 trace.");
  const magic = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3),
  );
  if (magic !== "ABIF") throw new Ab1ParseError("Not an AB1 file (missing ABIF signature).");

  const count = view.getInt32(ROOT_ENTRY_OFFSET + 12);
  const dirOffset = view.getInt32(ROOT_ENTRY_OFFSET + 20);
  if (count < 0 || dirOffset < 0 || dirOffset + count * ENTRY_SIZE > view.byteLength)
    throw new Ab1ParseError("AB1 directory points outside the file.");

  const entries = new Map<string, DirEntry>();
  for (let i = 0; i < count; i++) {
    const off = dirOffset + i * ENTRY_SIZE;
    const name = String.fromCharCode(
      view.getUint8(off),
      view.getUint8(off + 1),
      view.getUint8(off + 2),
      view.getUint8(off + 3),
    );
    const tag = `${name}${view.getInt32(off + 4)}`;
    entries.set(tag, {
      tag,
      elementType: view.getInt16(off + 8),
      elementSize: view.getInt16(off + 10),
      numElements: view.getInt32(off + 12),
      dataSize: view.getInt32(off + 16),
      dataOffset: view.getInt32(off + 20),
      entryOffset: off,
    });
  }
  return entries;
}

/** Byte range of an entry's payload, resolving the inline (≤ 4 bytes) case. */
function payload(view: DataView, e: DirEntry): { start: number; size: number } {
  const start = e.dataSize <= 4 ? e.entryOffset + 20 : e.dataOffset;
  if (e.dataSize < 0 || start < 0 || start + e.dataSize > view.byteLength)
    throw new Ab1ParseError(`AB1 tag ${e.tag} points outside the file.`);
  return { start, size: e.dataSize };
}

/**
 * Payload of a tag holding `numElements` elements of `elementSize` bytes. The
 * file states the count independently of the payload size, so the count is
 * checked against the payload before anything is allocated or read: a
 * malformed count must neither request a huge array nor read other tags' bytes.
 */
function elements(
  view: DataView,
  e: DirEntry,
  elementSize: number,
): { start: number; count: number } {
  const { start, size } = payload(view, e);
  if (e.elementSize !== elementSize || e.numElements < 0 || e.numElements * elementSize > size)
    throw new Ab1ParseError(`AB1 tag ${e.tag} has an inconsistent size.`);
  return { start, count: e.numElements };
}

/** Start of a payload that must hold at least `minSize` bytes (dates, times, longs). */
function fixed(view: DataView, e: DirEntry, minSize: number): number {
  const { start, size } = payload(view, e);
  if (size < minSize) throw new Ab1ParseError(`AB1 tag ${e.tag} is too short.`);
  return start;
}

function readBytes(view: DataView, e: DirEntry): Uint8Array {
  const { start, size } = payload(view, e);
  return new Uint8Array(view.buffer, view.byteOffset + start, size);
}

function readChars(view: DataView, e: DirEntry): string {
  let s = "";
  for (const b of readBytes(view, e)) s += String.fromCharCode(b);
  return s;
}

function readShorts(view: DataView, e: DirEntry): Int16Array {
  const { start, count } = elements(view, e, 2);
  const out = new Int16Array(count);
  for (let i = 0; i < count; i++) out[i] = view.getInt16(start + i * 2);
  return out;
}

/** Strings: type 18 = Pascal string (length byte first), 19 = C string, 2 = char array. */
function readString(view: DataView, e: DirEntry): string {
  const bytes = readBytes(view, e);
  let body = bytes;
  if (e.elementType === 18) body = bytes.subarray(1, 1 + bytes[0]);
  let s = "";
  for (const b of body) {
    if (b === 0) break;
    s += String.fromCharCode(b);
  }
  return s.trim();
}

function readDate(view: DataView, e: DirEntry): string {
  const start = fixed(view, e, 4);
  const y = view.getInt16(start);
  const m = view.getUint8(start + 2);
  const d = view.getUint8(start + 3);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function readTime(view: DataView, e: DirEntry): string {
  const start = fixed(view, e, 3);
  const parts = [view.getUint8(start), view.getUint8(start + 1), view.getUint8(start + 2)];
  return parts.map((p) => String(p).padStart(2, "0")).join(":");
}

const META_TAGS: { tag: string; label: string }[] = [
  { tag: "SMPL1", label: "Sample name" },
  { tag: "MCHN1", label: "Instrument" },
  { tag: "MODL1", label: "Model" },
  { tag: "TUBE1", label: "Well" },
  { tag: "LANE1", label: "Capillary" },
  { tag: "SPAC2", label: "Basecaller" },
  { tag: "SVER2", label: "Basecaller version" },
  { tag: "PDMF2", label: "Mobility file" },
  { tag: "RUND1", label: "Run started" },
  { tag: "RUND2", label: "Run finished" },
];

function readMetaValue(view: DataView, e: DirEntry): string | undefined {
  switch (e.elementType) {
    case 2:
    case 18:
    case 19:
      return readString(view, e);
    case 4: {
      const values = readShorts(view, e);
      return values.length > 0 ? String(values[0]) : undefined;
    }
    case 5:
      return String(view.getInt32(fixed(view, e, 4)));
    case 10:
      return readDate(view, e);
    default:
      return undefined;
  }
}

/** Metadata is informational: a malformed tag is skipped rather than failing a
 *  trace whose calls and traces read fine. */
function optional<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch (err) {
    if (err instanceof Ab1ParseError) return undefined;
    throw err;
  }
}

export function parseAb1(bytes: Uint8Array): Ab1Trace {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dir = readDirectory(view);
  const get = (...tags: string[]) => {
    for (const t of tags) {
      const e = dir.get(t);
      if (e) return e;
    }
    return undefined;
  };

  const basesEntry = get("PBAS2", "PBAS1");
  if (!basesEntry) throw new Ab1ParseError("AB1 file has no base calls (PBAS tag).");
  const sequence = readChars(view, basesEntry).toUpperCase();

  const qualEntry = get("PCON2", "PCON1");
  const quality = qualEntry ? Array.from(readBytes(view, qualEntry)) : [];

  const peaksEntry = get("PLOC2", "PLOC1");
  const peaks = peaksEntry ? Array.from(readShorts(view, peaksEntry)) : [];

  // FWO_ gives the base each DATA channel carries; DATA9..12 are the analyzed
  // (processed) traces, DATA1..4 the raw ones as a fallback.
  const orderEntry = get("FWO_1");
  const order = orderEntry ? readChars(view, orderEntry).toUpperCase() : "GATC";
  const empty = new Int16Array(0);
  const traces: Record<Ab1Base, Int16Array> = { A: empty, C: empty, G: empty, T: empty };
  for (let ch = 0; ch < 4; ch++) {
    const base = order[ch] as Ab1Base | undefined;
    const e = get(`DATA${9 + ch}`, `DATA${1 + ch}`);
    if (base && base in traces && e) traces[base] = readShorts(view, e);
  }
  const scanCount = Math.max(...Object.values(traces).map((t) => t.length));

  const meta: { label: string; value: string }[] = [];
  for (const { tag, label } of META_TAGS) {
    const e = dir.get(tag);
    if (!e) continue;
    let value = optional(() => readMetaValue(view, e));
    if (value === undefined || value === "") continue;
    // Run date and time are stored as separate tags; show them together.
    if (tag === "RUND1" || tag === "RUND2") {
      const timeEntry = dir.get(tag === "RUND1" ? "RUNT1" : "RUNT2");
      const time = timeEntry && optional(() => readTime(view, timeEntry));
      if (time) value = `${value} ${time}`;
    }
    meta.push({ label, value });
  }

  return {
    sequence,
    quality: quality.length === sequence.length ? quality : [],
    peaks: peaks.length === sequence.length ? peaks : [],
    traces,
    scanCount,
    meta,
  };
}
