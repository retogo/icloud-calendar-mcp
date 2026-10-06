import { describe, expect, test } from "bun:test";
import { CalDavClient, CalDavError } from "../src/caldav-client.ts";
import { RecurrenceBudget } from "../src/ical.ts";

const SERVER = "https://caldav.icloud.com";
const HOME = "https://p42-caldav.icloud.com:443/123/calendars/";
const WORK = "https://p42-caldav.icloud.com/123/calendars/work/";

type RecordedRequest = {
  method: string;
  url: string;
  headers: Headers;
  body: string;
};

function fakeFetch(routes: Record<string, () => Response>) {
  const requests: RecordedRequest[] = [];
  const fetch = async (input: string, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: await request.text(),
    });
    const route = routes[`${request.method} ${request.url}`];
    return route ? route() : new Response("not found", { status: 404 });
  };
  return { fetch: fetch as typeof globalThis.fetch, requests };
}

const multistatus = (body: string) =>
  new Response(
    `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:ic="http://apple.com/ns/ical/">${body}</d:multistatus>`,
    { status: 207, headers: { "Content-Type": "application/xml" } },
  );

const ok = (prop: string) =>
  `<d:propstat><d:prop>${prop}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>`;

function client(routes: Record<string, () => Response>) {
  const fake = fakeFetch(routes);
  return {
    client: new CalDavClient({
      serverUrl: SERVER,
      username: "me@icloud.com",
      password: "app-pass",
      fetch: fake.fetch,
    }),
    requests: fake.requests,
  };
}

describe("CalDavClient.listCalendars", () => {
  test("walks principal → calendar-home-set → event-capable calendars", async () => {
    const { client: caldav, requests } = client({
      [`PROPFIND ${SERVER}/`]: () =>
        multistatus(
          `<d:response><d:href>/</d:href>${ok("<d:current-user-principal><d:href>/123/principal/</d:href></d:current-user-principal>")}</d:response>`,
        ),
      [`PROPFIND ${SERVER}/123/principal/`]: () =>
        multistatus(
          `<d:response><d:href>/123/principal/</d:href>${ok(`<c:calendar-home-set><d:href>${HOME}</d:href></c:calendar-home-set>`)}</d:response>`,
        ),
      "PROPFIND https://p42-caldav.icloud.com/123/calendars/": () =>
        multistatus(
          [
            `<d:response><d:href>/123/calendars/</d:href>${ok("<d:resourcetype><d:collection/></d:resourcetype>")}</d:response>`,
            `<d:response><d:href>/123/calendars/work/</d:href>${ok(
              '<d:displayname>Work</d:displayname><ic:calendar-color>#FF2968FF</ic:calendar-color><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>',
            )}</d:response>`,
            `<d:response><d:href>/123/calendars/both/</d:href>${ok(
              '<d:displayname>Shared</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><c:supported-calendar-component-set><c:comp name="VEVENT"/><c:comp name="VTODO"/></c:supported-calendar-component-set>',
            )}</d:response>`,
            `<d:response><d:href>/123/calendars/tasks/</d:href>${ok(
              '<d:displayname>Reminders</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set>',
            )}</d:response>`,
          ].join(""),
        ),
    });

    expect(await caldav.listCalendars()).toEqual([
      { url: WORK, name: "Work", color: "#FF2968FF" },
      {
        url: "https://p42-caldav.icloud.com/123/calendars/both/",
        name: "Shared",
      },
    ]);
    expect(requests.map((r) => r.headers.get("Depth"))).toEqual([
      "0",
      "0",
      "1",
    ]);
    for (const request of requests) {
      expect(request.headers.get("Authorization")).toBe(
        `Basic ${btoa("me@icloud.com:app-pass")}`,
      );
    }
  });
});

describe("CalDavClient.listEvents", () => {
  test("queries the range in UTC and returns expanded recurring events", async () => {
    const { client: caldav, requests } = client({
      [`REPORT ${WORK}`]: () =>
        multistatus(
          `<d:response><d:href>/123/calendars/work/a.ics</d:href>${ok(
            '<d:getetag>"e1"</d:getetag><c:calendar-data>BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nSUMMARY:Weekly sync\r\nDTSTART:20261006T010000Z\r\nDTEND:20261006T020000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n</c:calendar-data>',
          )}</d:response>`,
        ),
    });

    const events = await caldav.listEvents(
      WORK,
      new Date("2026-10-06T00:00:00+09:00"),
      new Date("2026-10-07T00:00:00+09:00"),
      new RecurrenceBudget(),
    );

    expect(events).toEqual([
      {
        url: `${WORK}a.ics`,
        etag: '"e1"',
        uid: "a",
        summary: "Weekly sync",
        start: "2026-10-06T01:00:00Z",
        end: "2026-10-06T02:00:00Z",
        allDay: false,
      },
    ]);
    const [request] = requests;
    expect(request?.headers.get("Depth")).toBe("1");
    // Recurrences are expanded locally; asking the server to expand makes
    // iCloud drop VTIMEZONE without converting times to UTC
    expect(request?.body).toContain("<c:calendar-data/>");
    expect(request?.body).not.toContain("<c:expand");
    expect(request?.body).toContain(
      '<c:time-range start="20261005T150000Z" end="20261006T150000Z"/>',
    );
  });
});

describe("CalDavClient.createEvent", () => {
  test("sends a create-only PUT named after the UID", async () => {
    const { client: caldav, requests } = client({
      [`PUT ${WORK}new-1.ics`]: () => new Response(null, { status: 201 }),
    });

    const url = await caldav.createEvent(
      WORK,
      {
        uid: "new-1",
        summary: "Meeting",
        start: "2026-10-06T10:00:00+09:00",
        end: "2026-10-06T11:00:00+09:00",
        allDay: false,
      },
      new Date("2026-10-06T00:00:00Z"),
    );

    expect(url).toBe(`${WORK}new-1.ics`);
    const [request] = requests;
    expect(request?.headers.get("If-None-Match")).toBe("*");
    expect(request?.headers.get("Content-Type")).toBe(
      "text/calendar; charset=utf-8",
    );
    expect(request?.body).toContain("SUMMARY:Meeting");
  });
});

describe("CalDavClient.getEvent", () => {
  test("returns the calendar data and its ETag", async () => {
    const { client: caldav } = client({
      [`GET ${WORK}a.ics`]: () =>
        new Response("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", {
          headers: { ETag: '"e1"' },
        }),
    });

    expect(await caldav.getEvent(`${WORK}a.ics`)).toEqual({
      data: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n",
      etag: '"e1"',
    });
  });
});

describe("CalDavClient.updateEvent", () => {
  test("replaces the event only if it still has the given ETag", async () => {
    const { client: caldav, requests } = client({
      [`PUT ${WORK}a.ics`]: () => new Response(null, { status: 204 }),
    });

    await caldav.updateEvent(`${WORK}a.ics`, "BEGIN:VCALENDAR", '"e1"');

    const [request] = requests;
    expect(request?.headers.get("If-Match")).toBe('"e1"');
    expect(request?.headers.get("Content-Type")).toBe(
      "text/calendar; charset=utf-8",
    );
    expect(request?.body).toBe("BEGIN:VCALENDAR");
  });

  test("fails when the event changed since it was read", async () => {
    const { client: caldav } = client({
      [`PUT ${WORK}a.ics`]: () => new Response(null, { status: 412 }),
    });

    await expect(
      caldav.updateEvent(`${WORK}a.ics`, "BEGIN:VCALENDAR", '"old"'),
    ).rejects.toThrow(`PUT ${WORK}a.ics failed: 412`);
  });
});

describe("CalDavClient.deleteEvent", () => {
  test("sends DELETE to the event's URL", async () => {
    const { client: caldav, requests } = client({
      [`DELETE ${WORK}a.ics`]: () => new Response(null, { status: 204 }),
    });

    await caldav.deleteEvent(`${WORK}a.ics`);

    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      `DELETE ${WORK}a.ics`,
    ]);
  });

  test("throws an error with the method and status on non-2xx responses", async () => {
    const { client: caldav } = client({});

    const result = caldav.deleteEvent(`${WORK}missing.ics`);

    await expect(result).rejects.toBeInstanceOf(CalDavError);
    await expect(result).rejects.toThrow(
      `DELETE ${WORK}missing.ics failed: 404`,
    );
  });
});
