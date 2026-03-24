import type { KnownBlock } from "@slack/types";
import { createScopedLogger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import { getGmailClientWithRefresh } from "@/utils/gmail/client";
import { getCalendarClientWithRefresh } from "@/utils/calendar/client";
import {
  CALENDAR_IDS,
  TIMEZONE,
  DEFAULT_AUTONOMY_LEVELS,
  AutonomyMode,
  type CosCategory,
} from "@/utils/chief-of-staff/types";
import { loadClients } from "@/utils/chief-of-staff/briefing/gather";
import { generateAndPostBriefing } from "@/app/api/chief-of-staff/briefing/route";
import { processOneEmail } from "@/app/api/chief-of-staff/webhook/process";
import { postToChiefOfStaff } from "./poster";
import type { CommandContext } from "./command-router";

const logger = createScopedLogger("cos:commands");

const CALENDAR_NAMES: Record<string, string> = {
  [CALENDAR_IDS.personal]: "Personal",
  [CALENDAR_IDS.smartCollege]: "Smart College",
  [CALENDAR_IDS.rmsWork]: "RMS Work",
  [CALENDAR_IDS.praxis]: "Praxis",
  [CALENDAR_IDS.nutrition]: "Nutrition",
  [CALENDAR_IDS.workout]: "Workout",
};

export async function handleBriefing(_ctx: CommandContext) {
  try {
    await generateAndPostBriefing();
  } catch (error) {
    logger.error("Briefing command failed", { error });
  }
}

export async function handleEmail(_ctx: CommandContext) {
  try {
    const clients = await loadClients();

    const queries = [
      {
        label: "Smart College (24h)",
        query: "label:Smart-College newer_than:1d",
      },
      {
        label: "Unread direct (24h)",
        query: "is:unread newer_than:1d -category:promotions -category:social",
      },
      { label: "Overdue to-respond", query: "label:to-respond older_than:12h" },
    ];

    const sections: string[] = [];
    for (const { label, query } of queries) {
      const listRes = await clients.gmail.users.messages.list({
        userId: "me",
        q: query,
        maxResults: 5,
      });

      const count = listRes.data.resultSizeEstimate ?? 0;
      const messageIds = (listRes.data.messages ?? [])
        .map((m) => m.id)
        .filter(Boolean) as string[];

      if (messageIds.length === 0) {
        sections.push(`*${label}:* None`);
        continue;
      }

      sections.push(`*${label}:* ${count} message${count === 1 ? "" : "s"}`);

      const messages = await Promise.allSettled(
        messageIds.map((id) =>
          clients.gmail.users.messages.get({
            userId: "me",
            id,
            format: "metadata",
            metadataHeaders: ["From", "Subject"],
          }),
        ),
      );

      for (const msg of messages) {
        if (msg.status !== "fulfilled") continue;
        const headers = msg.value.data.payload?.headers ?? [];
        const from =
          headers.find((h) => h.name?.toLowerCase() === "from")?.value ?? "";
        const subject =
          headers.find((h) => h.name?.toLowerCase() === "subject")?.value ?? "";
        // Extract just the name from "Name <email>" format
        const fromName = from.replace(/<[^>]+>/, "").trim() || from;
        sections.push(`  â¢ ${fromName}: ${subject}`);
      }
    }

    const blocks: KnownBlock[] = [
      {
        type: "header",
        text: { type: "plain_text", text: "Email Summary", emoji: true },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: sections.join("\n") },
      },
    ];

    await postToChiefOfStaff({
      accessToken: clients.slack.accessToken,
      channelId: clients.slack.channelId,
      blocks,
      text: sections.join("\n"),
    });
  } catch (error) {
    logger.error("Email command failed", { error });
    await postErrorToSlack("email", error);
  }
}

export async function handleSchedule(_ctx: CommandContext) {
  try {
    const clients = await loadClients();

    const now = new Date();
    const startOfDay = new Date(
      now.toLocaleDateString("en-US", { timeZone: TIMEZONE }),
    );
    const endOfDay = new Date(startOfDay);
    endOfDay.setDate(endOfDay.getDate() + 1);

    const calendarIds = Object.entries(CALENDAR_IDS);
    const results = await Promise.allSettled(
      calendarIds.map(([, calId]) =>
        clients.calendar.events.list({
          calendarId: calId,
          timeMin: startOfDay.toISOString(),
          timeMax: endOfDay.toISOString(),
          singleEvents: true,
          orderBy: "startTime",
          timeZone: TIMEZONE,
        }),
      ),
    );

    const events: Array<{
      calendarName: string;
      end: string;
      start: string;
      summary: string;
    }> = [];

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status !== "fulfilled") continue;

      const calId = calendarIds[i][1];
      const calName = CALENDAR_NAMES[calId] ?? "Unknown";
      for (const event of result.value.data.items ?? []) {
        if (!event.summary) continue;
        events.push({
          summary: event.summary,
          calendarName: calName,
          start: event.start?.dateTime ?? event.start?.date ?? "",
          end: event.end?.dateTime ?? event.end?.date ?? "",
        });
      }
    }

    events.sort((a, b) => a.start.localeCompare(b.start));

    let text: string;
    if (events.length === 0) {
      text = "No events scheduled today.";
    } else {
      const lines = events.map((e) => {
        const time = e.start.includes("T")
          ? new Date(e.start).toLocaleTimeString("en-US", {
              timeZone: TIMEZONE,
              hour: "numeric",
              minute: "2-digit",
            })
          : "All day";
        return `â¢ *${time}* â ${e.summary} _(${e.calendarName})_`;
      });
      text = lines.join("\n");
    }

    const blocks: KnownBlock[] = [
      {
        type: "header",
        text: { type: "plain_text", text: "Today's Schedule", emoji: true },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text },
      },
    ];

    await postToChiefOfStaff({
      accessToken: clients.slack.accessToken,
      channelId: clients.slack.channelId,
      blocks,
      text,
    });
  } catch (error) {
    logger.error("Schedule command failed", { error });
    await postErrorToSlack("schedule", error);
  }
}

export async function handleClient(_ctx: CommandContext, clientQuery: string) {
  try {
    if (!clientQuery) {
      await postHelpToSlack("Usage: `/cos client <email or name>`");
      return;
    }

    // Lazy import to avoid circular dependencies
    const { checkVipStatus } = await import(
      "@/utils/chief-of-staff/vip/detector"
    );
    const prisma = (await import("@/utils/prisma")).default;

    const result = await checkVipStatus(clientQuery, prisma);

    const lines = [
      `*Client:* ${clientQuery}`,
      `*VIP Status:* ${result.isVip ? "Yes" : "No"} (${result.bookingCount} bookings)`,
    ];
    if (result.groupName) {
      lines.push(`*Group:* ${result.groupName}`);
    }

    const clients = await loadClients();
    const blocks: KnownBlock[] = [
      {
        type: "header",
        text: { type: "plain_text", text: "Client Lookup", emoji: true },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: lines.join("\n") },
      },
    ];

    await postToChiefOfStaff({
      accessToken: clients.slack.accessToken,
      channelId: clients.slack.channelId,
      blocks,
      text: lines.join("\n"),
    });
  } catch (error) {
    logger.error("Client command failed", { error, clientQuery });
    await postErrorToSlack("client", error);
  }
}

export async function handleHelp(_ctx: CommandContext) {
  // Help is posted ephemerally via the route's immediate response,
  // but if called directly we post to channel as fallback
  await postHelpToSlack();
}

export async function handleProcessEmail(_ctx: CommandContext, query: string) {
  try {
    if (!query) {
      await postHelpToSlack("Usage: `/cos handle <Gmail query>`");
      return;
    }

    const { emailAccount, gmail, calendarClient, slackChannel } =
      await loadEmailAccountClients();

    const autonomyLevels: Record<string, AutonomyMode> = {
      ...DEFAULT_AUTONOMY_LEVELS,
    };
    for (const level of emailAccount.autonomyLevels) {
      autonomyLevels[level.category] = level.mode as AutonomyMode;
    }

    const allowedDomains = extractJsonArray(
      emailAccount.chiefOfStaffConfig?.voiceTone,
      "allowedDomains",
    );
    const blockedDomains = extractJsonArray(
      emailAccount.chiefOfStaffConfig?.voiceTone,
      "blockedDomains",
    );

    // Search Gmail for matching messages
    const listRes = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: 5,
    });

    const messageIds = (listRes.data.messages ?? [])
      .map((m) => m.id)
      .filter(Boolean) as string[];

    if (messageIds.length === 0) {
      await postToChiefOfStaff({
        accessToken: slackChannel.accessToken,
        channelId: slackChannel.channelId,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `No emails found matching query: \`${query}\``,
            },
          },
        ],
        text: `No emails found matching query: ${query}`,
      });
      return;
    }

    await postToChiefOfStaff({
      accessToken: slackChannel.accessToken,
      channelId: slackChannel.channelId,
      blocks: [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: "Processing Emails",
            emoji: true,
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `Found ${messageIds.length} message${messageIds.length === 1 ? "" : "s"} matching: \`${query}\``,
          },
        },
      ],
      text: `Processing ${messageIds.length} message${messageIds.length === 1 ? "" : "s"}...`,
    });

    const results = await Promise.allSettled(
      messageIds.map((messageId) =>
        processOneEmail({
          messageId,
          emailAccount: {
            id: emailAccount.id,
            email: emailAccount.email,
            autonomyLevels: autonomyLevels as Record<
              CosCategory,
              AutonomyMode
            >,
          },
          gmail,
          calendarClient,
          slackChannel,
          allowedDomains,
          blockedDomains,
        }),
      ),
    );

    const successful = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter((r) => r.status === "rejected").length;

    await postToChiefOfStaff({
      accessToken: slackChannel.accessToken,
      channelId: slackChannel.channelId,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Batch Processing Complete*\nâ Processed: ${successful}\nâ Failed: ${failed}`,
          },
        },
      ],
      text: `Batch processing complete: ${successful} processed, ${failed} failed`,
    });
  } catch (error) {
    logger.error("Handle command failed", { error });
    await postErrorToSlack("handle", error);
  }
}

async function postErrorToSlack(command: string, _error: unknown) {
  try {
    const clients = await loadClients();
    await postToChiefOfStaff({
      accessToken: clients.slack.accessToken,
      channelId: clients.slack.channelId,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `Failed to run \`/cos ${command}\` â check server logs for details.`,
          },
        },
      ],
      text: `Failed to run /cos ${command}`,
    });
  } catch {
    logger.error("Failed to post error to Slack", { command });
  }
}

async function postHelpToSlack(extraMessage?: string) {
  try {
    const clients = await loadClients();
    const helpText = [
      extraMessage ? `${extraMessage}\n` : "",
      "*Available commands:*",
      "â¢ `/cos briefing` â Generate and post daily briefing",
      "â¢ `/cos email` â Scan inbox and post email summary",
      "â¢ `/cos schedule` â Show today's calendar",
      "â¢ `/cos client <email>` â Look up client history and VIP status",
      "â¢ `/cos handle <query>` â Search Gmail and process matching emails",
      "â¢ `/cos help` â Show this message",
    ]
      .filter(Boolean)
      .join("\n");

    await postToChiefOfStaff({
      accessToken: clients.slack.accessToken,
      channelId: clients.slack.channelId,
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: helpText },
        },
      ],
      text: helpText,
    });
  } catch {
    logger.error("Failed to post help to Slack");
  }
}

async function loadEmailAccountClients() {
  const emailAccount = await prisma.emailAccount.findUnique({
    where: { email: "nick@smartcollege.com" },
    include: {
      chiefOfStaffConfig: true,
      autonomyLevels: true,
      account: {
        select: {
          access_token: true,
          refresh_token: true,
          expires_at: true,
        },
      },
      messagingChannels: {
        where: { provider: "SLACK", isConnected: true },
        take: 1,
      },
      calendarConnections: {
        where: { provider: "google", isConnected: true },
        take: 1,
      },
    },
  });

  if (!emailAccount) {
    throw new Error("Smart College email account not found");
  }

  if (
    !emailAccount.account?.access_token ||
    !emailAccount.account?.refresh_token
  ) {
    throw new Error("Missing OAuth tokens for Smart College account");
  }

  const gmail = await getGmailClientWithRefresh({
    accessToken: emailAccount.account.access_token,
    refreshToken: emailAccount.account.refresh_token,
    expiresAt: emailAccount.account.expires_at
      ? emailAccount.account.expires_at.getTime()
      : null,
    emailAccountId: emailAccount.id,
    logger,
  });

  const calendarConn = emailAccount.calendarConnections[0];
  let calendarClient: Awaited<
    ReturnType<typeof getCalendarClientWithRefresh>
  > | null = null;
  if (calendarConn?.refreshToken) {
    try {
      calendarClient = await getCalendarClientWithRefresh({
        accessToken: calendarConn.accessToken,
        refreshToken: calendarConn.refreshToken,
        expiresAt: calendarConn.expiresAt?.getTime() ?? null,
        emailAccountId: emailAccount.id,
        logger,
      });
    } catch (err) {
      logger.warn("Could not build calendar client", { err });
    }
  }

  const slackChannel = emailAccount.messagingChannels[0] ?? null;

  return { emailAccount, gmail, calendarClient, slackChannel };
}

function extractJsonArray(
  json: string | null | undefined,
  field: string,
): string[] | undefined {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json);
    const value = parsed[field];
    if (Array.isArray(value)) return value;
  } catch {
    // voiceTone may not be valid JSON
  }
  return undefined;
}
