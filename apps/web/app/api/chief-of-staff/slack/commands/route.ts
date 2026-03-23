import { NextResponse, after } from "next/server";
import { createScopedLogger } from "@/utils/logger";
import { verifySlackSignature } from "@/app/api/chief-of-staff/slack/interactions/route";
import { routeCommand } from "@/utils/chief-of-staff/slack/command-router";

export const maxDuration = 300;

const logger = createScopedLogger("cos:slash-command");

const HELP_TEXT = [
  "*Available commands:*",
  "• `/cos briefing` — Generate and post daily briefing",
  "• `/cos email` — Scan inbox and post email summary",
  "• `/cos schedule` — Show today's calendar",
  "• `/cos client <email>` — Look up client history and VIP status",
  "• `/cos help` — Show this message",
].join("\n");

export async function POST(request: Request) {
  const rawBody = await request.text();

  const signature = request.headers.get("x-slack-signature");
  const timestamp = request.headers.get("x-slack-request-timestamp");

  if (!verifySlackSignature(signature, timestamp, rawBody)) {
    logger.warn("Invalid Slack signature on slash command");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const params = new URLSearchParams(rawBody);
  const commandText = params.get("text")?.trim() ?? "help";
  const userId = params.get("user_id") ?? "";
  const channelId = params.get("channel_id") ?? "";

  logger.info("Slash command received", { commandText, userId, channelId });

  // Help responds immediately (no async work needed)
  const subcommand = commandText.split(/\s+/)[0]?.toLowerCase();
  if (subcommand === "help" || !subcommand) {
    return NextResponse.json({
      response_type: "ephemeral",
      text: HELP_TEXT,
    });
  }

  // All other commands: acknowledge immediately, process in background
  after(() => routeCommand({ commandText, userId, channelId }));

  return NextResponse.json({
    response_type: "ephemeral",
    text: `Working on \`${commandText}\`...`,
  });
}
