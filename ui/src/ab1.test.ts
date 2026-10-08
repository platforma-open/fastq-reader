import { describe, expect, test } from "vitest";
import { Ab1ParseError, parseAb1 } from "./ab1";

// ---- a minimal ABIF writer, so each test controls the exact bytes ----------

type Tag = {
  name: string;
  num: number;
  type: number;
  elementSize: number;
  data: Uint8Array;
  /** Overrides for malformed files; default to what `data` implies. */
  numElements?: number;
  dataSize?: number;
  dataOffset?: number;
};

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

function int16s(values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 2);
  const view = new DataView(out.buffer);
  values.forEach((v, i) => view.setInt16(i * 2, v));
  return out;
}

const chars = (s: string) => ({ type: 2, elementSize: 1, data: ascii(s) });
const bytes = (values: number[]) => ({ type: 2, elementSize: 1, data: Uint8Array.from(values) });
const shorts = (values: number[]) => ({ type: 4, elementSize: 2, data: int16s(values) });
const pString = (s: string) => ({
  type: 18,
  elementSize: 1,
  data: Uint8Array.from([s.length, ...ascii(s)]),
});
const cString = (s: string) => ({ type: 19, elementSize: 1, data: ascii(`${s}\0`) });
const date = (y: number, m: number, d: number) => ({
  type: 10,
  elementSize: 4,
  data: Uint8Array.from([...int16s([y]), m, d]),
});
const time = (h: number, m: number, s: number) => ({
  type: 11,
  elementSize: 4,
  data: Uint8Array.from([h, m, s, 0]),
});

function tag(name: string, num: number, value: Omit<Tag, "name" | "num">): Tag {
  return { name, num, ...value };
}

const HEADER_SIZE = 128;
const ENTRY_SIZE = 28;

/** Header, then payloads over four bytes, then the directory. */
function abif(tags: Tag[]): Uint8Array {
  let pos = HEADER_SIZE;
  const offsets = tags.map((t) => {
    if (t.data.length <= 4) return -1;
    const at = pos;
    pos += t.data.length;
    return at;
  });
  const dirOffset = pos;
  const out = new Uint8Array(dirOffset + tags.length * ENTRY_SIZE);
  const view = new DataView(out.buffer);

  out.set(ascii("ABIF"), 0);
  view.setInt16(4, 101);
  out.set(ascii("tdir"), 6);
  view.setInt32(10, 1);
  view.setInt16(14, 1023);
  view.setInt16(16, ENTRY_SIZE);
  view.setInt32(18, tags.length);
  view.setInt32(22, tags.length * ENTRY_SIZE);
  view.setInt32(26, dirOffset);

  tags.forEach((t, i) => {
    const e = dirOffset + i * ENTRY_SIZE;
    out.set(ascii(t.name), e);
    view.setInt32(e + 4, t.num);
    view.setInt16(e + 8, t.type);
    view.setInt16(e + 10, t.elementSize);
    view.setInt32(e + 12, t.numElements ?? t.data.length / t.elementSize);
    view.setInt32(e + 16, t.dataSize ?? t.data.length);
    if (offsets[i] < 0) {
      out.set(t.data, e + 20); // inline: the payload occupies the offset field
      if (t.dataOffset !== undefined) view.setInt32(e + 20, t.dataOffset);
    } else {
      out.set(t.data, offsets[i]);
      view.setInt32(e + 20, t.dataOffset ?? offsets[i]);
    }
  });
  return out;
}

// ---- a small, well-formed trace -------------------------------------------

const SCANS = 60;
/** Distinct values per channel, so a mix-up of channels is visible. */
const channel = (k: number) => Array.from({ length: SCANS }, (_, i) => k * 1000 + i);

function traceTags(order = "TCAG"): Tag[] {
  return [
    tag("FWO_", 1, chars(order)),
    tag("PBAS", 2, chars("ACGTAC")),
    tag("PCON", 2, bytes([10, 20, 30, 40, 50, 60])),
    tag("PLOC", 2, shorts([5, 15, 25, 35, 45, 55])),
    tag("DATA", 9, shorts(channel(1))),
    tag("DATA", 10, shorts(channel(2))),
    tag("DATA", 11, shorts(channel(3))),
    tag("DATA", 12, shorts(channel(4))),
  ];
}

const without = (tags: Tag[], ...names: string[]) =>
  tags.filter((t) => !names.includes(`${t.name}${t.num}`));

const replace = (tags: Tag[], next: Tag) =>
  tags.map((t) => (t.name === next.name && t.num === next.num ? next : t));

describe("parseAb1", () => {
  test("reads calls, qualities and peaks, and maps channels by FWO_ order", () => {
    const t = parseAb1(abif(traceTags("TCAG")));
    expect(t.sequence).toBe("ACGTAC");
    expect(t.quality).toEqual([10, 20, 30, 40, 50, 60]);
    expect(t.peaks).toEqual([5, 15, 25, 35, 45, 55]);
    expect(t.scanCount).toBe(SCANS);
    // DATA9..12 carry the bases in FWO_ order: T, C, A, G.
    expect(Array.from(t.traces.T)).toEqual(channel(1));
    expect(Array.from(t.traces.C)).toEqual(channel(2));
    expect(Array.from(t.traces.A)).toEqual(channel(3));
    expect(Array.from(t.traces.G)).toEqual(channel(4));
  });

  test("assumes GATC when FWO_ is absent", () => {
    const t = parseAb1(abif(without(traceTags(), "FWO_1")));
    expect(Array.from(t.traces.G)).toEqual(channel(1));
    expect(Array.from(t.traces.C)).toEqual(channel(4));
  });

  test("prefers edited calls over the original ones", () => {
    const tags = [
      ...traceTags(),
      tag("PBAS", 1, chars("GGGGGG")),
      tag("PCON", 1, bytes([1, 1, 1, 1, 1, 1])),
      tag("PLOC", 1, shorts([1, 2, 3, 4, 5, 6])),
    ];
    const t = parseAb1(abif(tags));
    expect(t.sequence).toBe("ACGTAC");
    expect(t.quality).toEqual([10, 20, 30, 40, 50, 60]);
    expect(t.peaks).toEqual([5, 15, 25, 35, 45, 55]);
  });

  test("falls back to the original calls when edited ones are absent", () => {
    const tags = [
      ...without(traceTags(), "PBAS2", "PCON2", "PLOC2"),
      tag("PBAS", 1, chars("TTGA")),
      tag("PCON", 1, bytes([7, 8, 9, 10])),
      tag("PLOC", 1, shorts([3, 9, 14, 20])),
    ];
    const t = parseAb1(abif(tags));
    expect(t.sequence).toBe("TTGA");
    expect(t.quality).toEqual([7, 8, 9, 10]);
    expect(t.peaks).toEqual([3, 9, 14, 20]);
  });

  test("falls back to raw DATA1-4 when analyzed traces are absent", () => {
    const tags = [
      ...without(traceTags("GATC"), "DATA9", "DATA10", "DATA11", "DATA12"),
      tag("DATA", 1, shorts(channel(5))),
      tag("DATA", 2, shorts(channel(6))),
      tag("DATA", 3, shorts(channel(7))),
      tag("DATA", 4, shorts(channel(8))),
    ];
    const t = parseAb1(abif(tags));
    expect(Array.from(t.traces.G)).toEqual(channel(5));
    expect(Array.from(t.traces.T)).toEqual(channel(7));
  });

  test("reads payloads of four bytes or less stored inside the entry", () => {
    const tags = [
      ...without(traceTags(), "PBAS2", "PCON2", "PLOC2"),
      tag("PBAS", 2, chars("ac")),
      tag("PCON", 2, bytes([30, 31])),
      tag("PLOC", 2, shorts([4, 12])),
    ];
    const t = parseAb1(abif(tags));
    expect(t.sequence).toBe("AC"); // also upper-cased
    expect(t.quality).toEqual([30, 31]);
    expect(t.peaks).toEqual([4, 12]);
  });

  test("reads a file held in a view into a larger buffer", () => {
    const file = abif(traceTags());
    const padded = new Uint8Array(file.length + 7);
    padded.set(file, 3);
    expect(parseAb1(padded.subarray(3, 3 + file.length)).sequence).toBe("ACGTAC");
  });

  test("leaves quality empty when the file has none", () => {
    const t = parseAb1(abif(without(traceTags(), "PCON2")));
    expect(t.quality).toEqual([]);
    expect(t.sequence).toBe("ACGTAC");
  });

  test("drops qualities and peaks that don't pair up with the calls", () => {
    const tags = replace(
      replace(traceTags(), tag("PCON", 2, bytes([10, 20, 30, 40, 50]))),
      tag("PLOC", 2, shorts([5, 15, 25, 35])),
    );
    const t = parseAb1(abif(tags));
    expect(t.quality).toEqual([]);
    expect(t.peaks).toEqual([]);
  });

  test("collects run metadata, joining run date and time", () => {
    const tags = [
      ...traceTags(),
      tag("SMPL", 1, pString("Sample A")),
      tag("MCHN", 1, cString("3730xl")),
      tag("LANE", 1, shorts([57])),
      tag("RUND", 1, date(2025, 3, 19)),
      tag("RUNT", 1, time(18, 28, 7)),
    ];
    expect(parseAb1(abif(tags)).meta).toEqual([
      { label: "Sample name", value: "Sample A" },
      { label: "Instrument", value: "3730xl" },
      { label: "Capillary", value: "57" },
      { label: "Run started", value: "2025-03-19 18:28:07" },
    ]);
  });

  test("skips a malformed metadata tag instead of failing the trace", () => {
    const tags = [
      ...traceTags(),
      tag("SMPL", 1, pString("Sample A")),
      // A date needs four bytes; this one has two.
      tag("RUND", 1, { type: 10, elementSize: 4, data: Uint8Array.from([7, 233]), numElements: 1 }),
    ];
    const t = parseAb1(abif(tags));
    expect(t.meta).toEqual([{ label: "Sample name", value: "Sample A" }]);
    expect(t.sequence).toBe("ACGTAC");
  });
});

describe("parseAb1 on malformed files", () => {
  const rejects = (file: Uint8Array, message: RegExp) => {
    expect(() => parseAb1(file)).toThrow(Ab1ParseError);
    expect(() => parseAb1(file)).toThrow(message);
  };

  test("rejects a file without the ABIF signature", () => {
    const file = abif(traceTags());
    file.set(ascii("NOPE"), 0);
    rejects(file, /ABIF signature/);
  });

  test("rejects a file too short to hold a header", () => {
    rejects(new Uint8Array(12), /too short/);
  });

  test("rejects a directory that runs past the end of the file", () => {
    const file = abif(traceTags());
    rejects(file.subarray(0, file.length - 10), /directory points outside/);
  });

  test("rejects a trace without base calls", () => {
    rejects(abif(without(traceTags(), "PBAS2")), /no base calls/);
  });

  test("rejects an element count larger than its payload without allocating it", () => {
    // Four bytes of peaks claiming 2^31 - 1 elements (~4 GiB as Int16Array).
    const huge = { ...tag("PLOC", 2, shorts([4, 12])), numElements: 2147483647 };
    rejects(abif(replace(traceTags(), huge)), /PLOC2 has an inconsistent size/);
  });

  test("rejects an element count that would read into the next tag", () => {
    const over = { ...tag("DATA", 9, shorts(channel(1))), numElements: SCANS + 1 };
    rejects(abif(replace(traceTags(), over)), /DATA9 has an inconsistent size/);
  });

  test("rejects shorts declared with the wrong element size", () => {
    const odd = { ...tag("DATA", 10, shorts(channel(2))), elementSize: 1 };
    rejects(abif(replace(traceTags(), odd)), /DATA10 has an inconsistent size/);
  });

  test("rejects tag data that points past the end of the file", () => {
    const file = abif(traceTags());
    const truncated = { ...tag("DATA", 11, shorts(channel(3))), dataOffset: file.length - 2 };
    rejects(abif(replace(traceTags(), truncated)), /DATA11 points outside/);
  });

  test("rejects a negative data size", () => {
    const negative = { ...tag("PBAS", 2, chars("ACGTAC")), dataSize: -1 };
    rejects(abif(replace(traceTags(), negative)), /PBAS2 points outside/);
  });
});
