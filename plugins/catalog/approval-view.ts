/** Presentation only: agent intent never establishes effects or permission scope. */
export function approvalView(approval: { app: string; tool: string; input: unknown }) {
  const input = approval.input && typeof approval.input === "object" && !Array.isArray(approval.input)
    ? approval.input as Record<string, unknown> : {};
  const script = approval.tool.toLowerCase() === "execute" || typeof input.code === "string";
  const intent = typeof input.intent === "string" ? input.intent.trim().slice(0, 300) : "";
  const opaque = /^app_[a-f0-9-]+$/iu.test(approval.app);
  const integration = opaque ? "Executor script" : approval.app;
  return {
    script, integration,
    title: intent || (script ? "Run an Executor script" : `${integration}: ${approval.tool}`),
    description: intent ? "Purpose supplied by the agent" : null,
    reason: script
      ? "Executor has not provided a verified list of what this script reads or changes. Allow once runs this pending script. Any further approval requests will appear separately."
      : "Allow this pending call once, or allow this tool for the rest of this thread.",
  };
}
