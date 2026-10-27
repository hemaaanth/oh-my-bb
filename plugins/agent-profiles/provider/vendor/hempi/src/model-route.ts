/** Model Gateway's Pi extension registers this provider with the gateway's model IDs. */
export const GATEWAY_PROVIDER = "model-gateway";

/**
 * Inside a gateway-routed BB turn, a Codex model resolves to the gateway's
 * model of the same name, so hosts without a Codex login still work.
 * Outside managed turns it resolves as given. A missing gateway model never uses a native login.
 */
export function findModel<T>(registry: { find(provider: string, id: string): T | undefined }, provider: string, id: string): T | undefined {
 const managed = process.env.MODEL_GATEWAY_REQUIRED === "1" || !!process.env.MODEL_GATEWAY_BASE_URL;
 if (managed) {
  if (!process.env.MODEL_GATEWAY_BASE_URL || !process.env.MODEL_GATEWAY_TOKEN)
   throw new Error("Model Gateway settings are required for managed helper calls.");
  return registry.find(GATEWAY_PROVIDER, id);
 }
 return registry.find(provider, id);
}
