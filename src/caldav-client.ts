import {
  buildEvent,
  type CalendarEvent,
  type NewEvent,
  type Period,
  parseEvents,
  type RecurrenceBudget,
} from "./ical.ts";
import {
  type DavResponse,
  type PropValue,
  parseMultistatus,
} from "./multistatus.ts";

export type Calendar = {
  url: string;
  name: string;
  color?: string;
};

export type StoredEvent = CalendarEvent & {
  url: string;
  etag: string;
};

export type CalDavClientOptions = {
  serverUrl: string;
  username: string;
  password: string;
  fetch?: typeof fetch;
};

export class CalDavError extends Error {
  constructor(
    readonly method: string,
    readonly url: string,
    readonly status: number,
  ) {
    super(`${method} ${url} failed: ${status}`);
    this.name = "CalDavError";
  }
}

const NAMESPACES =
  'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:ic="http://apple.com/ns/ical/"';
const XML_DECLARATION = '<?xml version="1.0" encoding="utf-8"?>';
const CALENDAR_CONTENT_TYPE = "text/calendar; charset=utf-8";
const QUERY_MARGIN_MS = 24 * 60 * 60 * 1000;
const ISO_SEPARATORS = /[-:]|\.\d{3}/g;
const EVENT_COMPONENT = "VEVENT";

const PRINCIPAL_QUERY = `${XML_DECLARATION}<d:propfind ${NAMESPACES}><d:prop><d:current-user-principal/></d:prop></d:propfind>`;
const HOME_SET_QUERY = `${XML_DECLARATION}<d:propfind ${NAMESPACES}><d:prop><c:calendar-home-set/></d:prop></d:propfind>`;
const CALENDARS_QUERY = `${XML_DECLARATION}<d:propfind ${NAMESPACES}><d:prop><d:displayname/><d:resourcetype/><ic:calendar-color/><c:supported-calendar-component-set/></d:prop></d:propfind>`;

function eventsQuery(start: Date, end: Date): string {
  const range = `start="${toUtcDateTime(start)}" end="${toUtcDateTime(end)}"`;
  return `${XML_DECLARATION}<c:calendar-query ${NAMESPACES}><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="${EVENT_COMPONENT}"><c:time-range ${range}/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
}

function toUtcDateTime(date: Date): string {
  return date.toISOString().replace(ISO_SEPARATORS, "");
}

function child(
  value: PropValue | undefined,
  name: string,
): PropValue | undefined {
  return typeof value === "object" && !Array.isArray(value)
    ? value[name]
    : undefined;
}

function asList(value: PropValue | undefined): PropValue[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function hrefOf(response: DavResponse | undefined, prop: string): string {
  const href = child(response?.props[prop], "href");
  if (typeof href !== "string") {
    throw new Error(`${prop} is missing in the CalDAV response`);
  }
  return href;
}

function supportsEvents(response: DavResponse): boolean {
  const isCalendar =
    child(response.props.resourcetype, "calendar") !== undefined;
  const components = asList(
    child(response.props["supported-calendar-component-set"], "comp"),
  );
  return (
    isCalendar &&
    components.some((comp) => child(comp, "@name") === EVENT_COMPONENT)
  );
}

export class CalDavClient {
  private readonly serverUrl: string;
  private readonly authorization: string;
  private readonly fetch: typeof fetch;

  constructor(options: CalDavClientOptions) {
    this.serverUrl = options.serverUrl;
    this.authorization = `Basic ${btoa(`${options.username}:${options.password}`)}`;
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async listCalendars(): Promise<Calendar[]> {
    const root = new URL("/", this.serverUrl).href;
    const [principal] = await this.propfind(root, "0", PRINCIPAL_QUERY);
    const principalUrl = new URL(
      hrefOf(principal, "current-user-principal"),
      root,
    ).href;
    const [home] = await this.propfind(principalUrl, "0", HOME_SET_QUERY);
    const homeUrl = new URL(hrefOf(home, "calendar-home-set"), principalUrl)
      .href;
    const responses = await this.propfind(homeUrl, "1", CALENDARS_QUERY);
    return responses.filter(supportsEvents).map((response) => {
      const name = response.props.displayname;
      const color = response.props["calendar-color"];
      return {
        url: new URL(response.href, homeUrl).href,
        name: typeof name === "string" ? name : "",
        ...(typeof color === "string" ? { color } : {}),
      };
    });
  }

  async listEvents(
    calendarUrl: string,
    period: Period,
    budget: RecurrenceBudget,
  ): Promise<StoredEvent[]> {
    // The server may judge all-day events in UTC; widen the query and let
    // parseEvents filter in the user's time zone
    const responses = await this.multistatus(
      "REPORT",
      calendarUrl,
      "1",
      eventsQuery(
        new Date(period.start.getTime() - QUERY_MARGIN_MS),
        new Date(period.end.getTime() + QUERY_MARGIN_MS),
      ),
    );
    return responses.flatMap((response) => {
      const data = response.props["calendar-data"];
      const etag = response.props.getetag;
      if (typeof data !== "string") return [];
      const url = new URL(response.href, calendarUrl).href;
      return parseEvents(data, period, budget).map((event) => ({
        url,
        etag: typeof etag === "string" ? etag : "",
        ...event,
      }));
    });
  }

  async createEvent(
    calendarUrl: string,
    event: NewEvent,
    now: Date,
  ): Promise<string> {
    const url = new URL(`${encodeURIComponent(event.uid)}.ics`, calendarUrl)
      .href;
    await this.request(
      "PUT",
      url,
      {
        "Content-Type": CALENDAR_CONTENT_TYPE,
        "If-None-Match": "*",
      },
      buildEvent(event, now),
    );
    return url;
  }

  async getEvent(eventUrl: string): Promise<{ data: string; etag: string }> {
    const response = await this.request("GET", eventUrl, {});
    const etag = response.headers.get("ETag");
    if (etag === null) {
      throw new Error(`GET ${eventUrl} returned no ETag`);
    }
    return { data: await response.text(), etag };
  }

  /** Replaces the event only if it still has `etag`, so concurrent edits are not lost */
  async updateEvent(
    eventUrl: string,
    data: string,
    etag: string,
  ): Promise<void> {
    await this.request(
      "PUT",
      eventUrl,
      { "Content-Type": CALENDAR_CONTENT_TYPE, "If-Match": etag },
      data,
    );
  }

  async deleteEvent(eventUrl: string): Promise<void> {
    await this.request("DELETE", eventUrl, {});
  }

  private propfind(
    url: string,
    depth: "0" | "1",
    body: string,
  ): Promise<DavResponse[]> {
    return this.multistatus("PROPFIND", url, depth, body);
  }

  private async multistatus(
    method: string,
    url: string,
    depth: "0" | "1",
    body: string,
  ): Promise<DavResponse[]> {
    const response = await this.request(
      method,
      url,
      {
        Depth: depth,
        "Content-Type": "application/xml; charset=utf-8",
      },
      body,
    );
    return parseMultistatus(await response.text());
  }

  private async request(
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: string,
  ): Promise<Response> {
    const response = await this.fetch(url, {
      method,
      headers: { ...headers, Authorization: this.authorization },
      ...(body === undefined ? {} : { body }),
    });
    if (!response.ok) {
      throw new CalDavError(method, url, response.status);
    }
    return response;
  }
}
