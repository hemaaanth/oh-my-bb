import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { embedUrl, platformSchema, rpcContract, THREAD_CHANGED, type Platform } from "./contract.js";

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    "CREATE TABLE IF NOT EXISTS revyl_attached (thread_id TEXT NOT NULL, platform TEXT NOT NULL, session_id TEXT NOT NULL, PRIMARY KEY (thread_id, platform))",
    "CREATE TABLE IF NOT EXISTS revyl_embeds (project_id TEXT NOT NULL, platform TEXT NOT NULL, url TEXT NOT NULL, PRIMARY KEY (project_id, platform))",
  ]);
  const projectId = async (threadId: string) => (await bb.sdk.threads.get({ threadId })).projectId;
  const lookup = async (threadId: string, platform: Platform) => {
    const row = db.prepare("SELECT url FROM revyl_embeds WHERE project_id=? AND platform=?").get(await projectId(threadId), platform) as { url: string } | undefined;
    return row?.url ?? null;
  };
  const configure = async (threadId: string, platform: Platform, url: string) => {
    db.prepare("INSERT INTO revyl_embeds (project_id, platform, url) VALUES (?, ?, ?) ON CONFLICT(project_id, platform) DO UPDATE SET url=excluded.url").run(await projectId(threadId), platform, url);
    bb.realtime.publish(THREAD_CHANGED, { threadId, platform, issuedAt: Date.now() });
    return true;
  };
  bb.rpc.register(rpcContract, {
    revyl_embed: ({ threadId, platform }) => lookup(threadId, platform),
    revyl_configure: ({ threadId, platform, url }) => configure(threadId, platform, url),
  });
  bb.agents.registerTool({
    name: "revyl_show",
    description: "Open the configured Revyl public embed in this thread's Device tab. Opening shows a poster and does not start a billed session.",
    parameters: z.object({ platform: platformSchema }).strict(),
    async execute({ platform }, { threadId }) {
      if (!await lookup(threadId, platform)) return "No Revyl public embed is configured for this project's platform. Create one in Revyl App settings → General → Public embed, then configure its URL in project chat.";
      bb.realtime.publish(THREAD_CHANGED, { threadId, platform, issuedAt: Date.now() });
      return "Requested the Device tab in this thread. The user starts the interactive device from its poster.";
    },
  });
  bb.agents.registerTool({
    name: "revyl_configure",
    description: "Set the Revyl public embed URL for this project's platform. The URL grants anyone holding it permission to start billed demo sessions; confirm the selected app/build contains no sensitive data before configuring it. Does not start a session.",
    parameters: z.object({ platform: platformSchema, url: embedUrl }).strict(),
    async execute({ platform, url }, { threadId }) {
      await configure(threadId, platform, url);
      return `Configured the ${platform} public embed for this project. Open the Device tab to start a demo session.`;
    },
  });
  bb.agents.configure(() => ({ tools: ["revyl_show", "revyl_configure"], skills: ["revyl-device"], instructions: "Configure Revyl public embeds in project chat after reviewing the selected app/build and public access. Opening the Device tab does not start a session; the visitor starts a billed, short-lived session from its poster. Use revyl_show to open a configured embed." }));
}
