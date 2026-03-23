import {
  handleBriefing,
  handleClient,
  handleEmail,
  handleHelp,
  handleSchedule,
} from "./command-handlers";

export interface CommandContext {
  channelId: string;
  commandText: string;
  userId: string;
}

export function routeCommand(ctx: CommandContext) {
  const [subcommand, ...args] = ctx.commandText.split(/\s+/);

  switch (subcommand?.toLowerCase()) {
    case "briefing":
      return handleBriefing(ctx);
    case "email":
    case "inbox":
      return handleEmail(ctx);
    case "schedule":
    case "availability":
      return handleSchedule(ctx);
    case "client":
      return handleClient(ctx, args.join(" "));
    default:
      return handleHelp(ctx);
  }
}
