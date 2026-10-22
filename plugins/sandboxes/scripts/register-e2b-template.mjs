import { Template, waitForTimeout } from "e2b";

const [name, reference] = process.argv.slice(2);
if (!name || !reference) {
  throw new Error(
    "Usage: node register-e2b-template.mjs <name> <image-reference>",
  );
}
const apiKey = process.env.E2B_API_KEY?.trim();
if (!apiKey) throw new Error("E2B_API_KEY is not configured");
const username = process.env.BB_SANDBOX_IMAGE_REGISTRY_USERNAME?.trim();
const password = process.env.BB_SANDBOX_IMAGE_REGISTRY_TOKEN?.trim();

const template = Template()
  .fromImage(
    reference,
    username && password ? { username, password } : undefined,
  )
  .setStartCmd("sleep infinity", waitForTimeout(1_000));
let build;
try {
  build = await Template.build(template, name, {
    apiKey,
    cpuCount: 4,
    memoryMB: 8192,
    onBuildLogs: (entry) => process.stderr.write(`${entry.toString()}\n`),
  });
} catch (error) {
  // E2B build errors carry their cause on own properties rather than in
  // `message`, so surface them before rethrowing.
  const details = Object.fromEntries(
    Object.getOwnPropertyNames(error).map((key) => [key, error[key]]),
  );
  process.stderr.write(
    `${JSON.stringify({ name: error?.name, message: error?.message, details }, null, 2)}\n`,
  );
  throw error;
}
process.stdout.write(
  `${JSON.stringify({ buildId: build.buildId, name: build.name, templateId: build.templateId })}\n`,
);
