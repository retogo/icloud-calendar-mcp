import { describe, expect, test } from "bun:test";
import { parseEvents, RecurrenceBudget } from "../src/ical.ts";

const TOKYO = [
  "BEGIN:VTIMEZONE",
  "TZID:Asia/Tokyo",
  "BEGIN:STANDARD",
  "DTSTART:19390101T000000",
  "TZOFFSETFROM:+0900",
  "TZOFFSETTO:+0900",
  "TZNAME:JST",
  "END:STANDARD",
  "END:VTIMEZONE",
];

const NEW_YORK = [
  "BEGIN:VTIMEZONE",
  "TZID:America/New_York",
  "BEGIN:DAYLIGHT",
  "DTSTART:20070311T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
  "TZOFFSETFROM:-0500",
  "TZOFFSETTO:-0400",
  "TZNAME:EDT",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "DTSTART:20071104T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
  "TZOFFSETFROM:-0400",
  "TZOFFSETTO:-0500",
  "TZNAME:EST",
  "END:STANDARD",
  "END:VTIMEZONE",
];

const calendar = (...lines: string[]) =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//test//EN",
    ...TOKYO,
    ...NEW_YORK,
    ...lines,
    "END:VCALENDAR",
  ].join("\r\n");

const OCTOBER = {
  start: new Date("2026-10-01T00:00:00Z"),
  end: new Date("2026-11-01T00:00:00Z"),
  localOffsetSeconds: 0,
};

describe("parseEvents: single events", () => {
  test("returns UTC times with Z", () => {
    const ics = calendar(
      "BEGIN:VEVENT",
      "UID:abc-123",
      "SUMMARY:Weekly sync",
      "DTSTART:20261006T010000Z",
      "DTEND:20261006T020000Z",
      "LOCATION:Room A",
      "DESCRIPTION:Review the agenda",
      "END:VEVENT",
    );

    expect(parseEvents(ics, OCTOBER, new RecurrenceBudget())).toEqual([
      {
        uid: "abc-123",
        summary: "Weekly sync",
        start: "2026-10-06T01:00:00Z",
        end: "2026-10-06T02:00:00Z",
        allDay: false,
        location: "Room A",
        description: "Review the agenda",
      },
    ]);
  });

  test("returns TZID times with their UTC offset and time zone", () => {
    const ics = calendar(
      "BEGIN:VEVENT",
      "UID:u3",
      "SUMMARY:Dinner",
      "DTSTART;TZID=Asia/Tokyo:20261006T180000",
      "DTEND;TZID=Asia/Tokyo:20261006T200000",
      "END:VEVENT",
    );

    const [event] = parseEvents(ics, OCTOBER, new RecurrenceBudget());
    expect(event?.start).toBe("2026-10-06T18:00:00+09:00");
    expect(event?.end).toBe("2026-10-06T20:00:00+09:00");
    expect(event?.timeZone).toBe("Asia/Tokyo");
  });

  test("returns floating times without an offset", () => {
    const ics = calendar(
      "BEGIN:VEVENT",
      "UID:float",
      "SUMMARY:Wake up",
      "DTSTART:20261006T070000",
      "DTEND:20261006T071500",
      "END:VEVENT",
    );

    const [event] = parseEvents(ics, OCTOBER, new RecurrenceBudget());
    expect(event?.start).toBe("2026-10-06T07:00:00");
    expect(event).not.toHaveProperty("timeZone");
  });

  test("unfolds lines and unescapes text", () => {
    const ics = calendar(
      "BEGIN:VEVENT",
      "UID:u1",
      "SUMMARY:A\\, B\\; C",
      "DTSTART:20261006T010000Z",
      "DTEND:20261006T020000Z",
      "DESCRIPTION:Line one\\nline t",
      " wo continued",
      "END:VEVENT",
    );

    const [event] = parseEvents(ics, OCTOBER, new RecurrenceBudget());
    expect(event?.summary).toBe("A, B; C");
    expect(event?.description).toBe("Line one\nline two continued");
  });

  test("returns only dates for all-day events", () => {
    const ics = calendar(
      "BEGIN:VEVENT",
      "UID:u2",
      "SUMMARY:Vacation",
      "DTSTART;VALUE=DATE:20261010",
      "DTEND;VALUE=DATE:20261012",
      "END:VEVENT",
    );

    expect(parseEvents(ics, OCTOBER, new RecurrenceBudget())).toEqual([
      {
        uid: "u2",
        summary: "Vacation",
        start: "2026-10-10",
        end: "2026-10-12",
        allDay: true,
      },
    ]);
  });

  test("treats an all-day event without DTEND as ending the next day", () => {
    const ics = calendar(
      "BEGIN:VEVENT",
      "UID:u4",
      "SUMMARY:Birthday",
      "DTSTART;VALUE=DATE:20261031",
      "END:VEVENT",
    );

    expect(parseEvents(ics, OCTOBER, new RecurrenceBudget())[0]?.end).toBe(
      "2026-11-01",
    );
  });

  test("ends a timed event without DTEND at its start time", () => {
    const ics = calendar(
      "BEGIN:VEVENT",
      "UID:u5",
      "SUMMARY:Reminder",
      "DTSTART:20261006T010000Z",
      "END:VEVENT",
    );

    expect(parseEvents(ics, OCTOBER, new RecurrenceBudget())[0]?.end).toBe(
      "2026-10-06T01:00:00Z",
    );
  });

  test("ignores VALARM properties inside a VEVENT", () => {
    const ics = calendar(
      "BEGIN:VEVENT",
      "UID:u6",
      "SUMMARY:Doctor",
      "DTSTART:20261006T010000Z",
      "DTEND:20261006T020000Z",
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      "DESCRIPTION:Reminder",
      "TRIGGER:-PT15M",
      "END:VALARM",
      "END:VEVENT",
    );

    expect(
      parseEvents(ics, OCTOBER, new RecurrenceBudget())[0],
    ).not.toHaveProperty("description");
  });
});

describe("parseEvents: recurring events", () => {
  test("expands a recurrence rule into occurrences within the range", () => {
    const ics = calendar(
      "BEGIN:VEVENT",
      "UID:weekly",
      "SUMMARY:Standup",
      "DTSTART;TZID=Asia/Tokyo:20260922T093000",
      "DTEND;TZID=Asia/Tokyo:20260922T094500",
      "RRULE:FREQ=WEEKLY;COUNT=8",
      "END:VEVENT",
    );

    expect(
      parseEvents(ics, OCTOBER, new RecurrenceBudget()).map((e) => [
        e.uid,
        e.start,
        e.end,
      ]),
    ).toEqual([
      ["weekly", "2026-10-06T09:30:00+09:00", "2026-10-06T09:45:00+09:00"],
      ["weekly", "2026-10-13T09:30:00+09:00", "2026-10-13T09:45:00+09:00"],
      ["weekly", "2026-10-20T09:30:00+09:00", "2026-10-20T09:45:00+09:00"],
      ["weekly", "2026-10-27T09:30:00+09:00", "2026-10-27T09:45:00+09:00"],
    ]);
  });

  test("uses the offset of each occurrence across a daylight saving change", () => {
    const ics = calendar(
      "BEGIN:VEVENT",
      "UID:ny",
      "SUMMARY:NY call",
      "DTSTART;TZID=America/New_York:20261027T090000",
      "DTEND;TZID=America/New_York:20261027T100000",
      "RRULE:FREQ=WEEKLY;COUNT=2",
      "END:VEVENT",
    );

    const range = {
      start: new Date("2026-10-26T00:00:00Z"),
      end: new Date("2026-11-10T00:00:00Z"),
      localOffsetSeconds: 0,
    };
    expect(
      parseEvents(ics, range, new RecurrenceBudget()).map((e) => e.start),
    ).toEqual(["2026-10-27T09:00:00-04:00", "2026-11-03T09:00:00-05:00"]);
  });

  test("skips excluded dates", () => {
    const ics = calendar(
      "BEGIN:VEVENT",
      "UID:ex",
      "SUMMARY:Gym",
      "DTSTART:20261005T100000Z",
      "DTEND:20261005T110000Z",
      "RRULE:FREQ=WEEKLY;COUNT=3",
      "EXDATE:20261012T100000Z",
      "END:VEVENT",
    );

    expect(
      parseEvents(ics, OCTOBER, new RecurrenceBudget()).map((e) => e.start),
    ).toEqual(["2026-10-05T10:00:00Z", "2026-10-19T10:00:00Z"]);
  });

  test("applies modified occurrences", () => {
    const ics = calendar(
      "BEGIN:VEVENT",
      "UID:mod",
      "SUMMARY:Review",
      "DTSTART:20261005T100000Z",
      "DTEND:20261005T110000Z",
      "RRULE:FREQ=WEEKLY;COUNT=2",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:mod",
      "RECURRENCE-ID:20261012T100000Z",
      "SUMMARY:Review (moved)",
      "DTSTART:20261013T150000Z",
      "DTEND:20261013T160000Z",
      "END:VEVENT",
    );

    expect(
      parseEvents(ics, OCTOBER, new RecurrenceBudget()).map((e) => [
        e.summary,
        e.start,
      ]),
    ).toEqual([
      ["Review", "2026-10-05T10:00:00Z"],
      ["Review (moved)", "2026-10-13T15:00:00Z"],
    ]);
  });

  test("returns instances that the server already expanded", () => {
    const ics = calendar(
      "BEGIN:VEVENT",
      "UID:weekly",
      "SUMMARY:Weekly",
      "RECURRENCE-ID:20261006T010000Z",
      "DTSTART:20261006T010000Z",
      "DTEND:20261006T020000Z",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:weekly",
      "SUMMARY:Weekly",
      "RECURRENCE-ID:20261013T010000Z",
      "DTSTART:20261013T010000Z",
      "DTEND:20261013T020000Z",
      "END:VEVENT",
    );

    expect(
      parseEvents(ics, OCTOBER, new RecurrenceBudget()).map((e) => e.start),
    ).toEqual(["2026-10-06T01:00:00Z", "2026-10-13T01:00:00Z"]);
  });

  test("expands recurring all-day events as dates", () => {
    const ics = calendar(
      "BEGIN:VEVENT",
      "UID:monthly",
      "SUMMARY:Rent",
      "DTSTART;VALUE=DATE:20260925",
      "DTEND;VALUE=DATE:20260926",
      "RRULE:FREQ=MONTHLY",
      "END:VEVENT",
    );

    expect(
      parseEvents(ics, OCTOBER, new RecurrenceBudget()).map((e) => [
        e.start,
        e.end,
        e.allDay,
      ]),
    ).toEqual([["2026-10-25", "2026-10-26", true]]);
  });

  test("includes an occurrence moved into the period from before it", () => {
    const ics = calendar(
      "BEGIN:VEVENT",
      "UID:moved-in",
      "SUMMARY:Review",
      "DTSTART:20260901T100000Z",
      "DTEND:20260901T110000Z",
      "RRULE:FREQ=WEEKLY;COUNT=3",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:moved-in",
      "RECURRENCE-ID:20260908T100000Z",
      "SUMMARY:Review (postponed)",
      "DTSTART:20261002T100000Z",
      "DTEND:20261002T110000Z",
      "END:VEVENT",
    );

    expect(
      parseEvents(ics, OCTOBER, new RecurrenceBudget()).map((e) => [
        e.summary,
        e.start,
      ]),
    ).toEqual([["Review (postponed)", "2026-10-02T10:00:00Z"]]);
  });

  test("skips and reports an event whose rule needs too many iterations, keeping the rest", () => {
    const ics = calendar(
      "BEGIN:VEVENT",
      "UID:flood",
      "SUMMARY:Flood",
      "DTSTART:20260101T000000Z",
      "DURATION:PT1S",
      "RRULE:FREQ=SECONDLY",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:normal",
      "SUMMARY:Normal",
      "DTSTART:20261006T010000Z",
      "DTEND:20261006T020000Z",
      "END:VEVENT",
    );
    const budget = new RecurrenceBudget();

    const events = parseEvents(ics, OCTOBER, budget);

    expect(events.map((e) => e.uid)).toEqual(["normal"]);
    expect(budget.skipped).toEqual([{ uid: "flood", summary: "Flood" }]);
  });

  test("shares one budget across calendars and skips events once it runs out", () => {
    const weekly = (uid: string) =>
      calendar(
        "BEGIN:VEVENT",
        `UID:${uid}`,
        "SUMMARY:Weekly",
        "DTSTART:20260901T100000Z",
        "DURATION:PT1H",
        "RRULE:FREQ=WEEKLY",
        "END:VEVENT",
      );
    const budget = new RecurrenceBudget(10);

    const first = parseEvents(weekly("first"), OCTOBER, budget);
    const second = parseEvents(weekly("second"), OCTOBER, budget);

    expect(first).toHaveLength(4);
    expect(second).toEqual([]);
    expect(budget.skipped).toEqual([{ uid: "second", summary: "Weekly" }]);
  });
});

describe("parseEvents: time zone definitions", () => {
  test("does not reuse a time zone defined by an earlier calendar", () => {
    const poisoned = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VTIMEZONE",
      "TZID:Asia/Tokyo",
      "BEGIN:STANDARD",
      "DTSTART:19700101T000000",
      "TZOFFSETFROM:+0000",
      "TZOFFSETTO:+0000",
      "END:STANDARD",
      "END:VTIMEZONE",
      "BEGIN:VEVENT",
      "UID:p",
      "SUMMARY:Poisoned",
      "DTSTART;TZID=Asia/Tokyo:20261006T180000",
      "DTEND;TZID=Asia/Tokyo:20261006T190000",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const withoutZone = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:v",
      "SUMMARY:Victim",
      "DTSTART;TZID=Asia/Tokyo:20261006T180000",
      "DTEND;TZID=Asia/Tokyo:20261006T190000",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    parseEvents(poisoned, OCTOBER, new RecurrenceBudget());
    const [victim] = parseEvents(withoutZone, OCTOBER, new RecurrenceBudget());

    expect(victim?.start).not.toEndWith("+00:00");
  });
});

/** Calendar data without VTIMEZONE, as iCloud returns it */
const withoutTimezones = (...lines: string[]) =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", ...lines, "END:VCALENDAR"].join("\r\n");

describe("parseEvents: TZID without VTIMEZONE", () => {
  test("resolves an IANA TZID to its offset and keeps the time zone", () => {
    const ics = withoutTimezones(
      "BEGIN:VEVENT",
      "UID:dinner",
      "SUMMARY:Dinner",
      "DTSTART;TZID=Asia/Tokyo:20261006T180000",
      "DTEND;TZID=Asia/Tokyo:20261006T200000",
      "END:VEVENT",
    );

    const [event] = parseEvents(ics, OCTOBER, new RecurrenceBudget());

    expect(event).toMatchObject({
      start: "2026-10-06T18:00:00+09:00",
      end: "2026-10-06T20:00:00+09:00",
      timeZone: "Asia/Tokyo",
    });
  });

  test("uses each occurrence's offset across a daylight saving change", () => {
    const ics = withoutTimezones(
      "BEGIN:VEVENT",
      "UID:ny",
      "SUMMARY:NY call",
      "DTSTART;TZID=America/New_York:20261027T090000",
      "DTEND;TZID=America/New_York:20261027T100000",
      "RRULE:FREQ=WEEKLY;COUNT=2",
      "END:VEVENT",
    );
    const range = {
      start: new Date("2026-10-26T00:00:00Z"),
      end: new Date("2026-11-10T00:00:00Z"),
      localOffsetSeconds: 0,
    };

    expect(
      parseEvents(ics, range, new RecurrenceBudget()).map((e) => e.start),
    ).toEqual(["2026-10-27T09:00:00-04:00", "2026-11-03T09:00:00-05:00"]);
  });

  test("compares occurrences with the period by their real instant", () => {
    const ics = withoutTimezones(
      "BEGIN:VEVENT",
      "UID:edge",
      "SUMMARY:Edge",
      "DTSTART;TZID=Asia/Tokyo:20261006T180000",
      "DTEND;TZID=Asia/Tokyo:20261006T183000",
      "RRULE:FREQ=DAILY;COUNT=3",
      "END:VEVENT",
    );
    // 18:00 in Tokyo is 09:00Z, inside a period that ends at 10:00Z
    const period = {
      start: new Date("2026-10-06T08:00:00Z"),
      end: new Date("2026-10-06T10:00:00Z"),
      localOffsetSeconds: 0,
    };

    expect(
      parseEvents(ics, period, new RecurrenceBudget()).map((e) => e.start),
    ).toEqual(["2026-10-06T18:00:00+09:00"]);
  });

  test("leaves a TZID that is not an IANA name as floating time", () => {
    const ics = withoutTimezones(
      "BEGIN:VEVENT",
      "UID:custom",
      "SUMMARY:Custom",
      "DTSTART;TZID=My Custom Zone:20261006T180000",
      "DTEND;TZID=My Custom Zone:20261006T190000",
      "END:VEVENT",
    );

    const [event] = parseEvents(ics, OCTOBER, new RecurrenceBudget());

    expect(event?.start).toBe("2026-10-06T18:00:00");
    expect(event).not.toHaveProperty("timeZone");
  });
});

const JST_OFFSET_SECONDS = 9 * 60 * 60;
const jst = (start: string, end: string) => ({
  start: new Date(`${start}+09:00`),
  end: new Date(`${end}+09:00`),
  localOffsetSeconds: JST_OFFSET_SECONDS,
});

describe("parseEvents: all-day and floating times in the user's time zone", () => {
  // An all-day event on 10/17 only (DTEND is exclusive)
  const onkura = withoutTimezones(
    "BEGIN:VEVENT",
    "UID:onkura",
    "SUMMARY:Onkura",
    "DTSTART;VALUE=DATE:20261017",
    "DTEND;VALUE=DATE:20261018",
    "END:VEVENT",
  );

  test.each([
    [
      "10/16 0:00 - 10/17 0:00",
      "2026-10-16T00:00:00",
      "2026-10-17T00:00:00",
      false,
    ],
    [
      "10/17 0:00 - 10/17 9:00",
      "2026-10-17T00:00:00",
      "2026-10-17T09:00:00",
      true,
    ],
    [
      "10/17 0:00 - 10/18 0:00",
      "2026-10-17T00:00:00",
      "2026-10-18T00:00:00",
      true,
    ],
    [
      "10/18 0:00 - 10/19 0:00",
      "2026-10-18T00:00:00",
      "2026-10-19T00:00:00",
      false,
    ],
    [
      "10/18 8:00 - 10/18 9:00",
      "2026-10-18T08:00:00",
      "2026-10-18T09:00:00",
      false,
    ],
    [
      "10/18 9:00 - 10/19 0:00",
      "2026-10-18T09:00:00",
      "2026-10-19T00:00:00",
      false,
    ],
  ])(
    "treats an all-day event as local midnight to midnight: %s JST",
    (_, start, end, included) => {
      const events = parseEvents(
        onkura,
        jst(start, end),
        new RecurrenceBudget(),
      );

      expect(events.map((e) => e.uid)).toEqual(included ? ["onkura"] : []);
    },
  );

  test("interprets floating times in the user's time zone", () => {
    const ics = withoutTimezones(
      "BEGIN:VEVENT",
      "UID:float",
      "SUMMARY:Wake up",
      "DTSTART:20261018T083000",
      "DTEND:20261018T084500",
      "END:VEVENT",
    );

    expect(
      parseEvents(
        ics,
        jst("2026-10-18T08:00:00", "2026-10-18T09:00:00"),
        new RecurrenceBudget(),
      ).map((e) => e.uid),
    ).toEqual(["float"]);
  });

  test("expands recurring all-day events in the user's time zone", () => {
    const ics = withoutTimezones(
      "BEGIN:VEVENT",
      "UID:daily",
      "SUMMARY:Daily",
      "DTSTART;VALUE=DATE:20261015",
      "DTEND;VALUE=DATE:20261016",
      "RRULE:FREQ=DAILY;COUNT=10",
      "END:VEVENT",
    );

    expect(
      parseEvents(
        ics,
        jst("2026-10-18T00:00:00", "2026-10-19T00:00:00"),
        new RecurrenceBudget(),
      ).map((e) => e.start),
    ).toEqual(["2026-10-18"]);
  });
});
