import { describe, expect, test } from "bun:test";
import { applyEventChanges } from "../src/ical.ts";

const NOW = new Date("2026-10-07T00:00:00Z");

const existing = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Apple Inc.//iCloud//EN",
  "BEGIN:VEVENT",
  "UID:abc",
  "DTSTAMP:20261001T000000Z",
  "DTSTART;TZID=Asia/Tokyo:20261006T180000",
  "DTEND;TZID=Asia/Tokyo:20261006T200000",
  "SUMMARY:Dinner",
  "LOCATION:Shibuya",
  "RRULE:FREQ=WEEKLY",
  "BEGIN:VALARM",
  "ACTION:DISPLAY",
  "DESCRIPTION:Reminder",
  "TRIGGER:-PT15M",
  "END:VALARM",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:abc",
  "RECURRENCE-ID;TZID=Asia/Tokyo:20261013T180000",
  "DTSTART;TZID=Asia/Tokyo:20261013T190000",
  "DTEND;TZID=Asia/Tokyo:20261013T210000",
  "SUMMARY:Dinner (late)",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const lines = (ics: string) => ics.split("\r\n");

describe("applyEventChanges", () => {
  test("changes only the given fields of the series and keeps everything else", () => {
    const ics = applyEventChanges(existing, { summary: "Team dinner" }, NOW);

    expect(lines(ics)).toContain("SUMMARY:Team dinner");
    expect(lines(ics)).toContain("LOCATION:Shibuya");
    expect(lines(ics)).toContain("RRULE:FREQ=WEEKLY");
    expect(lines(ics)).toContain("TRIGGER:-PT15M");
    expect(lines(ics)).toContain("DTSTART;TZID=Asia/Tokyo:20261006T180000");
    expect(lines(ics)).toContain("SUMMARY:Dinner (late)");
  });

  test("bumps SEQUENCE and DTSTAMP on the series", () => {
    const once = applyEventChanges(existing, { summary: "A" }, NOW);
    const twice = applyEventChanges(once, { summary: "B" }, NOW);

    expect(lines(once)).toContain("SEQUENCE:1");
    expect(lines(twice)).toContain("SEQUENCE:2");
    expect(lines(once)).toContain("DTSTAMP:20261007T000000Z");
  });

  test("writes new timed start and end in UTC", () => {
    const ics = applyEventChanges(
      existing,
      {
        start: "2026-10-06T19:00:00+09:00",
        end: "2026-10-06T21:00:00+09:00",
        allDay: false,
      },
      NOW,
    );

    expect(lines(ics)).toContain("DTSTART:20261006T100000Z");
    expect(lines(ics)).toContain("DTEND:20261006T120000Z");
  });

  test("writes new all-day dates as DATE values", () => {
    const ics = applyEventChanges(
      existing,
      { start: "2026-10-10", end: "2026-10-11", allDay: true },
      NOW,
    );

    expect(lines(ics)).toContain("DTSTART;VALUE=DATE:20261010");
    expect(lines(ics)).toContain("DTEND;VALUE=DATE:20261011");
  });

  test("accepts LF line endings and writes CRLF", () => {
    const ics = applyEventChanges(
      existing.replaceAll("\r\n", "\n"),
      { summary: "Team dinner" },
      NOW,
    );

    expect(lines(ics)).toContain("SUMMARY:Team dinner");
    expect(lines(ics)).toContain("TRIGGER:-PT15M");
  });

  test("removes a field set to null", () => {
    const ics = applyEventChanges(existing, { location: null }, NOW);

    expect(ics).not.toContain("LOCATION:");
  });

  test("prevents property injection through line breaks in text", () => {
    const ics = applyEventChanges(
      existing,
      { summary: "a\r\nX-INJECTED:1\rEND:VEVENT" },
      NOW,
    );

    expect(lines(ics).some((line) => line.startsWith("X-INJECTED"))).toBe(
      false,
    );
    expect(lines(ics).filter((line) => line === "END:VEVENT")).toHaveLength(2);
  });
});
