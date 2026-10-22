import { fileURLToPath } from "node:url";
import { Freestyle } from "freestyle";
import { createPortableBootstrapScript } from "../src/bootstrap-script.js";

const [snapshotName, baseSnapshotId] = process.argv.slice(2);
if (
  snapshotName === undefined ||
  !/^bb-sandbox-[a-z0-9][a-z0-9-]{0,62}$/.test(snapshotName)
) {
  throw new Error(
    "Usage: tsx plugins/sandboxes/scripts/publish-freestyle-snapshot.ts bb-sandbox-<version> [base-snapshot-id]",
  );
}
const apiKey = process.env.FREESTYLE_API_KEY?.trim();
if (!apiKey) throw new Error("FREESTYLE_API_KEY is not configured");

const client = new Freestyle({ apiKey });
const { vm, vmId } = await client.vms.create({
  ...(baseSnapshotId === undefined ? {} : { snapshotId: baseSnapshotId }),
  name: `${snapshotName}-builder`,
  persistence: { type: "sticky", priority: 5 },
});

try {
  const bootstrap = await createPortableBootstrapScript({
    dockerDir: fileURLToPath(new URL("../docker/", import.meta.url)),
    installSystemPackages: true,
    installOptionalToolsInBackground: false,
    startDaemon: false,
  });
  process.stderr.write(
    `Preparing Freestyle snapshot on ${vmId} (${Buffer.byteLength(bootstrap)}-byte bootstrap)\n`,
  );
  await vm.fs.writeTextFile("/tmp/bb-sandbox-bootstrap.sh", bootstrap);
  const launch = await vm.exec({
    command:
      "rm -f /tmp/bb-snapshot-bootstrap.exit; chmod 700 /tmp/bb-sandbox-bootstrap.sh; " +
      "nohup bash -c 'HOME=/root /tmp/bb-sandbox-bootstrap.sh; code=$?; printf \"%s\\n\" \"$code\" > /tmp/bb-snapshot-bootstrap.exit' " +
      ">/tmp/bb-snapshot-bootstrap.log 2>&1 </dev/null &",
    timeoutMs: 30_000,
  });
  if ((launch.statusCode ?? 1) !== 0) {
    throw new Error(launch.stderr?.trim() || "Could not start Freestyle snapshot bootstrap");
  }
  const bootstrapDeadline = Date.now() + 30 * 60 * 1_000;
  for (;;) {
    const status = await vm.exec({
      command:
        "if [ -f /tmp/bb-snapshot-bootstrap.exit ]; then printf 'complete:'; cat /tmp/bb-snapshot-bootstrap.exit; else printf 'running'; fi",
      timeoutMs: 30_000,
    });
    const state = status.stdout?.trim() ?? "";
    if (state.startsWith("complete:")) {
      if (state !== "complete:0") {
        const logs = await vm.exec({
          command: "tail -120 /tmp/bb-snapshot-bootstrap.log",
          timeoutMs: 30_000,
        });
        throw new Error(
          logs.stdout?.trim() || `Freestyle snapshot bootstrap exited ${state.slice("complete:".length)}`,
        );
      }
      break;
    }
    if (Date.now() >= bootstrapDeadline) {
      throw new Error("Timed out waiting for Freestyle snapshot bootstrap");
    }
    process.stderr.write("Freestyle toolchain build is still running\n");
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }

  const validation = await vm.exec({
    command:
      "HOME=/root; PATH=/root/.local/bin:/usr/local/bin:/usr/local/go/bin:/opt/rust/cargo/bin:/opt/java/bin:$PATH; export HOME PATH; " +
      "for executable in bb-host-daemon omp claude codex go rustc cargo python3 uv java git gh rg jq docker posthog-cli vercel railway ntn slack-cli grain hubspot linear-cli clickhouse; do command -v \"$executable\" >/dev/null || { echo \"Missing $executable\" >&2; exit 1; }; done",
    timeoutMs: 30_000,
  });
  if ((validation.statusCode ?? 1) !== 0) {
    throw new Error(validation.stderr?.trim() || "Freestyle snapshot validation failed");
  }

  const created = await vm.snapshot({ name: snapshotName });
  const deadline = Date.now() + 30 * 60 * 1_000;
  for (;;) {
    const snapshot = await client.vms.snapshots.get({
      snapshotId: created.snapshotId,
    });
    process.stderr.write(`Snapshot ${created.snapshotId}: ${snapshot.state ?? "unknown"}\n`);
    if (snapshot.state === "ready") {
      process.stdout.write(
        `${JSON.stringify({ snapshotId: created.snapshotId, name: snapshotName })}\n`,
      );
      break;
    }
    if (
      snapshot.failed === true ||
      snapshot.state === "failed" ||
      snapshot.state === "cancelled" ||
      snapshot.state === "lost"
    ) {
      throw new Error(`Freestyle snapshot entered ${snapshot.state ?? "failed"} state`);
    }
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Freestyle snapshot");
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
} finally {
  await client.vms.delete({ vmId }).catch(() => undefined);
}
