import { describe, expect, test } from "bun:test";
import { parseMultistatus } from "../src/multistatus.ts";

describe("parseMultistatus", () => {
  test("strips namespaces and returns only 200 propstats keyed by href", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:ic="http://apple.com/ns/ical/">
  <d:response>
    <d:href>/123/calendars/home/</d:href>
    <d:propstat>
      <d:prop>
        <d:displayname>Work</d:displayname>
        <ic:calendar-color>#FF2968FF</ic:calendar-color>
        <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
    <d:propstat>
      <d:prop><d:getetag/></d:prop>
      <d:status>HTTP/1.1 404 Not Found</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/123/calendars/inbox/</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/></d:resourcetype>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;

    const responses = parseMultistatus(xml);

    expect(responses.map((r) => r.href)).toEqual([
      "/123/calendars/home/",
      "/123/calendars/inbox/",
    ]);
    expect(responses[0]?.props).toEqual({
      displayname: "Work",
      "calendar-color": "#FF2968FF",
      resourcetype: { collection: "", calendar: "" },
    });
    expect(responses[1]?.props).toEqual({
      resourcetype: { collection: "" },
    });
  });

  test("returns an array even for a single response", () => {
    const xml = `<multistatus xmlns="DAV:"><response><href>/p/</href>
<propstat><prop><current-user-principal><href>/123/principal/</href></current-user-principal></prop>
<status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`;

    expect(parseMultistatus(xml)).toEqual([
      {
        href: "/p/",
        props: { "current-user-principal": { href: "/123/principal/" } },
      },
    ]);
  });

  test("keeps calendar-data newlines and numeric-looking values as strings", () => {
    const xml = `<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><response><href>/e/1.ics</href>
<propstat><prop><getetag>"123"</getetag><C:calendar-data>BEGIN:VCALENDAR&#13;
END:VCALENDAR&#13;
</C:calendar-data></prop>
<status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`;

    const props = parseMultistatus(xml)[0]?.props;
    expect(props?.getetag).toBe('"123"');
    expect(props?.["calendar-data"]).toStartWith(
      "BEGIN:VCALENDAR\r\nEND:VCALENDAR",
    );
  });
});
