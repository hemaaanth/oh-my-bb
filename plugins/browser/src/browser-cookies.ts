export function cookieState(message: unknown) {
  if (!message || typeof message !== "object" || !("cookies" in message) || !Array.isArray(message.cookies) || message.cookies.length > 30000) throw new Error("Invalid snapshot");
  const skippedPartitioned = message.cookies.filter((cookie) => cookie && typeof cookie === "object" && cookie.partitionKey).length;
  const cookies = message.cookies.filter((cookie) => !cookie || typeof cookie !== "object" || !cookie.partitionKey).map((cookie) => {
    if (!cookie || typeof cookie.name !== "string" || typeof cookie.value !== "string" ||
        typeof cookie.domain !== "string" || !cookie.domain || typeof cookie.path !== "string" ||
        typeof cookie.secure !== "boolean" || typeof cookie.httpOnly !== "boolean" ||
        (cookie.expirationDate !== undefined && !Number.isFinite(cookie.expirationDate))) throw new Error("Invalid cookie");
    const sameSite = { no_restriction: "None", lax: "Lax", strict: "Strict" }[String(cookie.sameSite) as "no_restriction" | "lax" | "strict"];
    return {
      name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path,
      expires: cookie.session || cookie.expirationDate === undefined ? -1 : cookie.expirationDate,
      secure: cookie.secure, httpOnly: cookie.httpOnly,
      ...(sameSite ? { sameSite } : {}),
    };
  });
  cookies.sort((a, b) => JSON.stringify([a.domain, a.path, a.name]).localeCompare(JSON.stringify([b.domain, b.path, b.name])));
  return { cookies, origins: [], bbCookieSync: true, skippedPartitioned };
}
