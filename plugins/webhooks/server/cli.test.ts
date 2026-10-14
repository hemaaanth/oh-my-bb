import { afterEach, describe, expect, it, vi } from "vitest";
import { generateSigningSecret } from "./auth.js";
import { SLACK_SECRET, THREAD, postSigned, sendConfig, slackEventsConfig, webhooksHost, type Host } from "./test-fakes.js";

afterEach(() => vi.unstubAllGlobals());

const cli = (host: Host, ...argv: string[]) => host.harness.behavior.runCli(argv);
const createdId = (stdout: string) => /wh_[a-z0-9]+/.exec(stdout)![0];

describe("bb webhooks", () => {
  it("creates an endpoint without printing its secret unless asked", async () => {
    const host = await webhooksHost({ settings: { publicBaseUrl: "https://hooks.example.com" } });
    const hidden = await cli(host, "create", "--config", JSON.stringify(sendConfig()));
    expect(hidden.exitCode).toBe(0);
    expect(hidden.stdout).toContain("but not shown");
    expect(hidden.stdout).not.toMatch(/whsec_/);
    expect(hidden.stdout).toContain("URL: https://hooks.example.com/api/v1/plugins/webhooks/http/deliver?endpoint=wh_");

    const asJson = await cli(host, "create", "--config", JSON.stringify(sendConfig()), "--json");
    expect(JSON.parse(asJson.stdout)).toMatchObject({ secret: null, url: expect.stringContaining("endpoint=wh_") });
    expect(asJson.stdout).not.toMatch(/whsec_/);

    const shown = await cli(host, "create", "--config", JSON.stringify(sendConfig()), "--show-secret");
    const secret = /whsec_[A-Za-z0-9+/=]+/.exec(shown.stdout)![0];
    expect((await postSigned(host, createdId(shown.stdout), secret, { event: { event: "x" } })).status).toBe(200);
    expect(JSON.stringify(host.harness.inspection.logEntries)).not.toContain(secret);
    await host.harness.lifecycle.dispose();
  });

  it("imports a secret and never echoes it", async () => {
    const host = await webhooksHost();
    const imported = generateSigningSecret();
    const result = await cli(host, "create", "--config", JSON.stringify(sendConfig()), "--secret", imported, "--show-secret", "--json");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(imported);
    expect(JSON.parse(result.stdout)).toMatchObject({ secret: null, endpoint: { secretHint: imported.slice(-4) } });
    await host.harness.lifecycle.dispose();
  });

  it("sets up a slack endpoint only with an imported signing secret", async () => {
    const host = await webhooksHost();
    const refused = await cli(host, "create", "--config", JSON.stringify(slackEventsConfig()));
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("Signing Secret");
    const id = createdId((await cli(host, "create", "--config", JSON.stringify(sendConfig()))).stdout);
    const updated = await cli(host, "update", id, "--config", JSON.stringify(slackEventsConfig()), "--secret", SLACK_SECRET, "--show-secret");
    expect(updated.exitCode).toBe(0);
    expect(updated.stdout).toContain(`Updated ${id}  on   slack`);
    expect(updated.stdout).not.toContain(SLACK_SECRET);
    await host.harness.lifecycle.dispose();
  });

  it("lists, shows, disables, and deletes with confirmation", async () => {
    const host = await webhooksHost();
    expect((await cli(host, "list")).stdout).toContain("No endpoints");
    const id = createdId((await cli(host, "create", "--config", JSON.stringify(sendConfig()))).stdout);
    expect((await cli(host, "list")).stdout).toContain(`${id}  on   standard-webhooks  PostHog alerts → send to thread ${THREAD}`);

    const show = await cli(host, "show", id);
    expect(show.stdout).toContain("URL: https://<your-public-origin>/api/v1/plugins/webhooks/http/deliver?endpoint=");
    expect(show.stdout).toContain("Fields: event=event.event:string!, person=person.properties.email:string");
    expect(show.stdout).toContain("No deliveries yet.");

    expect((await cli(host, "disable", id)).stdout).toContain(`Disabled ${id}  off`);
    const refused = await cli(host, "delete", id);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("--yes");
    expect((await cli(host, "delete", id, "--yes")).stdout).toBe(`Deleted ${id}.`);
    expect((await cli(host, "show", id)).exitCode).not.toBe(0);
    await host.harness.lifecycle.dispose();
  });

  it("tests a signed delivery and lists it", async () => {
    const host = await webhooksHost();
    const id = createdId((await cli(host, "create", "--config", JSON.stringify(sendConfig()))).stdout);
    const test = await cli(host, "test", id, "--payload", JSON.stringify({ event: { event: "cli check" } }));
    expect(test.stdout).toMatch(/^HTTP 200\n/);
    expect(host.sent).toHaveLength(1);
    const listed = await cli(host, "deliveries", id);
    expect(listed.stdout).toMatch(/whd_\S+ {2}succeeded {2}attempts=1 {2}thread=thr_target/);
    expect(listed.stdout).not.toContain("cli check");
    await host.harness.lifecycle.dispose();
  });

  it("explains bad input without a stack trace", async () => {
    const host = await webhooksHost();
    const badJson = await cli(host, "create", "--config", "{nope");
    expect(badJson.exitCode).not.toBe(0);
    expect(badJson.stderr).toContain("--config is not valid JSON");
    const badConfig = await cli(host, "create", "--config", JSON.stringify(sendConfig({ action: { type: "send", threadId: THREAD, message: "{{nope}}" } })));
    expect(badConfig.exitCode).not.toBe(0);
    expect(badConfig.stderr).toContain("nope");
    expect(badConfig.stderr).not.toMatch(/\n\s+at /);
    await host.harness.lifecycle.dispose();
  });

  it("rotates a secret and hides it by default", async () => {
    const host = await webhooksHost();
    const id = createdId((await cli(host, "create", "--config", JSON.stringify(sendConfig()))).stdout);
    const hidden = await cli(host, "rotate-secret", id, "--json");
    expect(JSON.parse(hidden.stdout).secret).toBeNull();
    const shown = await cli(host, "rotate-secret", id, "--show-secret");
    expect(shown.stdout).toMatch(/Signing secret \(shown once\): whsec_/);
    await host.harness.lifecycle.dispose();
  });
});
