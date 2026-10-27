// @vitest-environment jsdom
import { fireEvent, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { expect, it } from "vitest";
import { RoutingProfileEditor } from "./routing-editor";

it("edits tag pills and preserves unsaved routing text while using no model call", async () => {
  let saved: unknown;
  let generation = 0;
  const project = {
    id: "synthetic",
    name: "Synthetic",
    gitRemoteUrl: null,
    localPath: null,
    groupId: null,
    position: 0,
    icon: "",
    machineCount: 0,
    routingProfile: {
      description: "Original",
      keywords: ["billing"],
      aliases: [],
      repositories: [],
      notFor: [],
      source: "manual" as const,
      updatedAt: null,
      learnedFor: [],
      learnedNotFor: [],
      learnedAt: null,
    },
  };
  function Probe() {
    return (
      <RoutingProfileEditor
        project={project}
        busy={false}
        configured
        onSave={async (value) => {
          saved = value;
          return true;
        }}
        onGenerate={async () => {
          generation++;
        }}
      />
    );
  }
  const v = renderSlot({ component: Probe }, {}, {});
  const tags = v.getByLabelText("Keywords");
  fireEvent.change(tags, { target: { value: "webhooks" } });
  fireEvent.keyDown(tags, { key: "Enter" });
  fireEvent.click(
    v.getByRole("button", { name: "Remove billing from Keywords" }),
  );
  fireEvent.change(v.getByLabelText("Description"), {
    target: { value: "Draft description" },
  });
  fireEvent.click(v.getByRole("button", { name: "Save description" }));
  await waitFor(() =>
    expect(saved).toMatchObject({
      description: "Draft description",
      keywords: ["webhooks"],
    }),
  );
  expect(generation).toBe(0);
  v.lifecycle.unmount();
});
