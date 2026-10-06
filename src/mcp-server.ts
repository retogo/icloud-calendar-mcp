import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { CalendarTools } from "./tools.ts";

const SERVER_INFO = { name: "icloud-calendar-mcp", version: "0.1.0" };

const dateTimeWithOffset = z.iso.datetime({ offset: true });
const periodBoundary = z.union([z.iso.date(), dateTimeWithOffset]);

function json(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

export function createMcpServer(tools: CalendarTools): McpServer {
  const server = new McpServer(SERVER_INFO);

  server.registerTool(
    "list_calendars",
    {
      title: "List calendars",
      description:
        "List the iCloud calendars that hold events. Pass a returned `url` as `calendarUrl` to the other tools.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => json(await tools.listCalendars()),
  );

  server.registerTool(
    "list_events",
    {
      title: "List events",
      description:
        "List events in a period, ordered by start. Recurring events are expanded into occurrences. Timed events are ISO 8601 date-times with an explicit offset (`Z` or e.g. `+09:00`) plus `timeZone` when the event has one; compare them as instants, not strings. All-day events are dates with an exclusive `end`. Returns `{ events, skipped }`; `skipped` lists recurring events too expensive to expand, which are missing from `events`.",
      inputSchema: z.object({
        start: dateTimeWithOffset.describe(
          "Start of the period as ISO 8601 with an offset, e.g. 2026-10-06T00:00:00+09:00",
        ),
        end: dateTimeWithOffset.describe("End of the period (exclusive)"),
        calendarUrls: z
          .array(z.url())
          .optional()
          .describe("Calendar URLs to search. Defaults to all calendars"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => json(await tools.listEvents(input)),
  );

  server.registerTool(
    "create_event",
    {
      title: "Create event",
      description:
        "Create an event. Dates (YYYY-MM-DD) for `start` and `end` make an all-day event, where `end` is the day after the last day. Otherwise use ISO 8601 date-times with an offset.",
      inputSchema: z.object({
        calendarUrl: z.url().describe("A `url` returned by list_calendars"),
        summary: z.string().min(1).describe("Title of the event"),
        start: periodBoundary,
        end: periodBoundary,
        location: z.string().optional(),
        description: z.string().optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (input) => json(await tools.createEvent(input)),
  );

  server.registerTool(
    "update_event",
    {
      title: "Update event",
      description:
        "Change fields of an event by the `url` returned by list_events. Omitted fields stay as they are; `null` removes location or description. Give `start` and `end` together, in the same form as create_event. Alarms, attendees, and recurrence rules are kept. Updating a recurring event changes the whole series. Fails if the event changed elsewhere since it was read.",
      inputSchema: z.object({
        eventUrl: z.url(),
        summary: z.string().min(1).optional(),
        start: periodBoundary.optional(),
        end: periodBoundary.optional(),
        location: z.string().nullable().optional(),
        description: z.string().nullable().optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => json(await tools.updateEvent(input)),
  );

  server.registerTool(
    "delete_event",
    {
      title: "Delete event",
      description:
        "Delete an event by the `url` returned by list_events. Deleting a recurring event removes the whole series.",
      inputSchema: z.object({
        eventUrl: z.url(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      await tools.deleteEvent(input);
      return json({ deleted: input.eventUrl });
    },
  );

  return server;
}
