// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DeleteSectionDialog } from "./DeleteSectionDialog";
import { CompactViewportOverrideProvider } from "./ui/hooks/use-compact-viewport";

afterEach(() => { cleanup(); vi.useRealTimers(); });

it("focuses Cancel and restores the invoking control when a mobile confirmation unmounts", () => {
  vi.useFakeTimers();
  let removals = 0;
  function Fixture() {
    const [open, setOpen] = useState(false);
    return <CompactViewportOverrideProvider isCompactViewport>
      <button onClick={() => setOpen(true)}>Delete fixture section</button>
      {open ? <DeleteSectionDialog
        workspace={{ id: "fixture-section", name: "Fixture section", color: "blue", isDefault: false, projectIds: [], threadIds: [] }}
        onDismiss={() => setOpen(false)}
        onRemove={async () => { removals += 1; }}
      /> : null}
    </CompactViewportOverrideProvider>;
  }
  render(<Fixture />);
  const trigger = screen.getByRole("button", { name: "Delete fixture section" });
  trigger.focus();
  fireEvent.click(trigger);
  act(() => vi.runOnlyPendingTimers());
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(removals).toBe(0);
});
