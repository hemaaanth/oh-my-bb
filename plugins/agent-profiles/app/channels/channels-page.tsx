import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { ChannelChat } from "./channel-chat";
import { ChannelList, CreateChannel } from "./channel-list";
import { channelIdFromSubPath, channelMessageIdFromSubPath } from "./channel-path";

export function ChannelsPage({ subPath }: PluginNavPanelProps) {
  if (!subPath) return <ChannelList />;
  if (subPath === "new") return <CreateChannel />;
  const id = channelIdFromSubPath(subPath);
  if (!id) return <ChannelList />;
  const messageId = channelMessageIdFromSubPath(subPath);
  return (
    <main className="flex h-full min-h-0 flex-col bg-background">
      <ChannelChat key={id} id={id} messageId={messageId} />
    </main>
  );
}
