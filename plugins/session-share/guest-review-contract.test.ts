import { describe, expect, it } from "vitest";
import { guestListOutputSchema } from "./guest-review-contract.js";

describe("guest review projection", () => {
  it("retains public feedback while stripping private fields at every nesting level", () => {
    const result = guestListOutputSchema.parse({
      rows: [{
        annotation: {
          id: "pp_public", comment: "Public feedback", elementPath: "main > button", timestamp: 1,
          x: 12, y: 34, element: "button", kind: "feedback", url: "https://preview.example.test/page",
          sourceFile: "PRIVATE_SOURCE_MARKER", fullPath: "PRIVATE_FULL_PATH_MARKER",
          pinpoint: {
            selector: "button", pathname: "/page", title: "Preview", xIsPercentage: false,
            guestReview: { reviewRef: "PRIVATE_REVIEW_MARKER", participantRef: "PRIVATE_ACTOR_MARKER", pendingOwnerDispatch: true },
            proposedLearning: { text: "PRIVATE_LEARNING_MARKER" },
            anchorOffset: { x: 2, y: 3, privateExtension: "PRIVATE_ANCHOR_MARKER" },
          },
          thread: [{ role: "human", content: "Public reply", guest: true, id: "PRIVATE_MESSAGE_MARKER" }],
        },
        workflowState: "open", summary: null, screenshots: [], createdAt: 1,
        guestPending: true, guestCanDelete: true, authoredByGuest: true,
        projectId: "PRIVATE_PROJECT_MARKER", routing: { assignedThreadId: "PRIVATE_AGENT_MARKER" },
      }],
      privateExtension: "PRIVATE_ROOT_MARKER",
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
    expect(result.rows[0]?.annotation.comment).toBe("Public feedback");
    expect(result.rows[0]?.annotation.thread).toEqual([{ role: "human", content: "Public reply", guest: true }]);
    expect(result.rows[0]?.annotation.pinpoint.anchorOffset).toEqual({ x: 2, y: 3 });
  });
});
