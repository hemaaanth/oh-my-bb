import { expect, it } from "vitest";
import { approvalView } from "./approval-view";
it("shows intent without treating it as verified effects", () => {
  const view = approvalView({ app: "app_a3bf775f-6d3b-4824-9bb4-24e0fe861ca3", tool: "execute", input: { intent: "Read orders", code: "deleteEverything()" } });
  expect(view).toMatchObject({ script: true, integration: "Executor script", title: "Read orders", description: "Purpose supplied by the agent" });
  expect(view.reason).toContain("verified list");
});
it("detects code under an arbitrary tool name and handles missing intent", () => {
  expect(approvalView({ app: "custom", tool: "run", input: { code: "x" } })).toMatchObject({ script: true, title: "Run an Executor script" });
  expect(approvalView({ app: "slack", tool: "send", input: null }).script).toBe(false);
});
