// New in the gateway: `bb gateway doctor` reports Account Pooler
// coexistence (plan decision 8.1, S5) plus a secondary, confirming
// per-host diagnostic. `resolveProviderEnvHealth` on the server is
// first-loaded-plugin-wins, independent of which plugin's contributeEnv
// entries actually won the provider's env, so `providerStates(...).planLabel`
// alone cannot prove which plugin is inactive -- it only confirms the
// isAccountPoolRouting() gate when they agree.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { ACCOUNT_POOL_BLOCKED_LABEL, isAccountPoolRouting } from "./coexistence.js";

export interface DoctorHostReport {
  hostId: string;
  hostName: string;
  claudeCodePlanLabel: string | null;
  codexPlanLabel: string | null;
}

export interface DoctorReport {
  accountPoolInstalledAndEnabled: boolean;
  hosts: DoctorHostReport[];
}

export async function runGatewayDoctor(
  bb: Pick<BbPluginApi, "sdk">,
): Promise<DoctorReport> {
  const accountPoolInstalledAndEnabled = await isAccountPoolRouting(bb);
  const hosts = await bb.sdk.hosts.list();
  const reports: DoctorHostReport[] = [];
  for (const host of hosts) {
    const states = await bb.sdk.system.providerStates({ hostId: host.id });
    reports.push({
      hostId: host.id,
      hostName: host.name,
      claudeCodePlanLabel:
        states.providers.find((provider) => provider.providerId === "claude-code")
          ?.planLabel ?? null,
      codexPlanLabel:
        states.providers.find((provider) => provider.providerId === "codex")
          ?.planLabel ?? null,
    });
  }
  return { accountPoolInstalledAndEnabled, hosts: reports };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [
    `Account Pooler installed and enabled: ${report.accountPoolInstalledAndEnabled}`,
    report.accountPoolInstalledAndEnabled
      ? `Model Gateway contributes no env for claude-code/codex; health label reads "${ACCOUNT_POOL_BLOCKED_LABEL}".`
      : "Model Gateway is free to route claude-code/codex.",
    "",
    "Per-host provider plan label (secondary diagnostic; reflects the first-loaded plugin with both a contributeEnv and a health resolver for that provider):",
  ];
  if (report.hosts.length === 0) {
    lines.push("No enrolled hosts.");
  } else {
    for (const host of report.hosts) {
      lines.push(
        `${host.hostName}\tclaude-code=${host.claudeCodePlanLabel ?? "-"}\tcodex=${host.codexPlanLabel ?? "-"}`,
      );
    }
  }
  return lines.join("\n");
}
