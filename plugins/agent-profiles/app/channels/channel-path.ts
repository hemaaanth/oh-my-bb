const channelIdPattern = /^[a-f0-9-]{36}$/;

export function channelIdFromSubPath(subPath: string) {
  const first = subPath.split("/")[0] ?? "";
  return channelIdPattern.test(first) ? first : null;
}

export function channelMessageIdFromSubPath(subPath: string) {
  const parts = subPath.split("/");
  if (parts[1] !== "message") return undefined;
  let messageId = parts.slice(2).join("/");
  try {
    for (let pass = 0; pass < 2; pass += 1) {
      const decoded = decodeURIComponent(messageId);
      if (decoded === messageId) break;
      messageId = decoded;
    }
  } catch {
    return undefined;
  }
  return messageId || undefined;
}

export const isMissingChannel = (error: string) => /channel not found/iu.test(error);
