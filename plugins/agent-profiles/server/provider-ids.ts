export const HEMPI_PROVIDER_ID = "hempi";

export const AGENTS_PROVIDER_ID = "agents";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function agentModelId(profileId: string): string {
  if (!UUID.test(profileId)) throw new Error("Invalid agent profile ID.");
  return `agent/${profileId.toLowerCase()}`;
}

export function profileIdFromAgentModel(model: string): string {
  const match = /^agent\/([0-9a-f-]+)$/u.exec(model);
  if (!match || !UUID.test(match[1]!)) throw new Error("Invalid agent model ID.");
  return match[1]!;
}

