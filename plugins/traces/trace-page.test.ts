import { expect, it } from "vitest";
import { tracePage, eventPage } from "./trace-page";
import { buildTrace } from "./spans";
it("pages nested spans without losing continuation or exposing hidden inputs", () => {
  const result = buildTrace({ id: "thr", title: null, providerId: "codex", environmentId: null, parentThreadId: null, createdAt: 0, updatedAt: 1, status: "idle" }, []);
  result.tree.children = Array.from({ length: 150 }, (_, i) => ({ ...result.tree, id: `s${i}`, name: "executor_execute", children: [] }));
  const first = tracePage(result, 0, 50, "executor_execute");
  expect(first.total).toBe(150); expect(first.spans).toHaveLength(50); expect(first.nextOffset).toBe(50);
  expect(tracePage(result, 100, 50, "executor_execute").nextOffset).toBeNull();
  expect(tracePage(result, 0, 50, "absent").total).toBe(0);
});

it("searches full events before clipping, and hides payloads by default", () => {
  const events = [{ id: "e", threadId: "thr", seq: 1, type: "item/completed", createdAt: 1, scope: { kind: "thread" as const }, data: { code: "x".repeat(10000) + "unique-call" } }];
  expect(eventPage(events, 0, 10, "unique-call").total).toBe(0);
  const page = eventPage(events, 0, 10, "unique-call", true);
  expect(page.total).toBe(1); expect(page.events[0].payload).toContain("unique-call");
  expect(page.events[0].payloadTruncated).toBe(true);
  expect(JSON.stringify(eventPage(events))).not.toContain("unique-call");
});
