import { z } from "zod";

export const PREVIEW_MAX_BYTES = 32 * 1024 * 1024;
export const PREVIEW_SANDBOX = "allow-scripts allow-forms allow-popups";
export const PREVIEW_ERROR_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": `sandbox ${PREVIEW_SANDBOX}; default-src 'none'; base-uri 'none'; form-action 'none'`,
  "access-control-allow-origin": "*",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

export const preparedPreviewSchema = z.object({
  isolationVersion: z.literal(1),
  contentType: z.string().min(1).max(256).regex(/^[^\r\n]+$/),
  bodyBase64: z.string().max(Math.ceil(PREVIEW_MAX_BYTES / 3) * 4),
  headers: z.record(z.string(), z.string()).superRefine((headers, context) => {
    const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
    const sandbox = normalized["content-security-policy"]?.split(";").map((directive) => directive.trim()).find((directive) => directive.startsWith("sandbox "));
    if (sandbox?.split(/\s+/).slice(1).sort().join(" ") !== PREVIEW_SANDBOX.split(" ").sort().join(" ") ||
      normalized["access-control-allow-origin"] !== "*" || normalized["cache-control"] !== "no-store" ||
      normalized["referrer-policy"] !== "no-referrer" || normalized["x-content-type-options"] !== "nosniff" ||
      Object.entries(normalized).some(([key, value]) => !Object.hasOwn(PREVIEW_ERROR_HEADERS, key) || /[\r\n]/.test(value))) {
      context.addIssue({ code: "custom", message: "Pinpoint returned an incompatible preview isolation contract." });
    }
  }),
});
