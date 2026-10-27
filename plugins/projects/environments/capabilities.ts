import type { CapabilityId } from "./contract.js";

export interface CapabilityDefinition {
  id: CapabilityId;
  name: string;
  command: string;
  description: string;
  installHint: string;
  credentialAlternatives: string[][];
}

export const capabilityCatalog: readonly CapabilityDefinition[] = [
  {
    id: "hubspot", name: "HubSpot", command: "hubspot", description: "HubSpot CRM and project configuration.", installHint: "Install the HubSpot Agent CLI for this image or machine.",
    credentialAlternatives: [["HUBSPOT_ACCESS_TOKEN"]],
  },
  {
    id: "clickhouse", name: "ClickHouse", command: "clickhouse", description: "ClickHouse SQL and administrative access.", installHint: "Install the ClickHouse client for this image or machine.",
    credentialAlternatives: [["CLICKHOUSE_URL"], ["CLICKHOUSE_HOST", "CLICKHOUSE_USER", "CLICKHOUSE_PASSWORD"]],
  },
  {
    id: "doppler", name: "Doppler", command: "doppler", description: "Project-scoped application configuration and secrets.", installHint: "Install the Doppler CLI for this image or machine.",
    credentialAlternatives: [["DOPPLER_TOKEN"]],
  },
] as const;

export const capabilityById = new Map(capabilityCatalog.map((item) => [item.id, item]));
