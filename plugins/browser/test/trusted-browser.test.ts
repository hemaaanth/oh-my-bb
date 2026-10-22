import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { NO_TRUSTED_BROWSER, trustedBrowserPayload } from "../src/trusted-browser.js";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
it("imports enrollment keys only from private files", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-seed-")); directories.push(root);
  const file = join(root, "key");
  await writeFile(file, "TAILSCALE_AUTH_KEY=fixture-private-key\n", {mode:0o600});
  expect((await trustedBrowserPayload({...NO_TRUSTED_BROWSER, browserTailscaleAuthKeyFile:file})).payload.tailscaleAuthKey).toBe("fixture-private-key");
  await writeFile(file, "TAILSCALE_AUTH_KEY=fixture-changed-key\n");
  await chmod(file,0o644);
  const refused = await trustedBrowserPayload({...NO_TRUSTED_BROWSER, browserTailscaleAuthKeyFile:file});
  expect(refused.payload.tailscaleAuthKey).toBe(""); expect(refused.warnings.join(" ")).not.toContain("fixture-changed-key");
});
it("keeps required authentication fail-closed when a seed cannot be read", async () => {
  const missing = await trustedBrowserPayload({...NO_TRUSTED_BROWSER, browserStateFile:"/nonexistent/browser-seed.json"});
  expect(missing.payload.requiredState).toBe("default"); expect(missing.payload.state).toBeNull();
});
it("does not import oversized authentication state", async () => {
  const root=await mkdtemp(join(tmpdir(),"browser-seed-size-"));directories.push(root);
  const file=join(root,"seed.json");await writeFile(file,"x".repeat(5*1024*1024+1),{mode:0o600});
  const result=await trustedBrowserPayload({...NO_TRUSTED_BROWSER,browserStateFile:file});
  expect(result.payload.requiredState).toBe("default");expect(result.payload.state).toBeNull();
});
