import { describe, expect, it } from "vitest";
import { renderSharedMarkdown } from "./markdown.js";

describe("renderSharedMarkdown", () => {
  it("renders chat formatting while removing executable HTML", () => {
    const rendered = renderSharedMarkdown(
      "## Result\n\n**Safe** [bad](javascript:alert(1))<script>alert(2)</script>",
    );

    expect(rendered).toContain("<h2>Result</h2>");
    expect(rendered).toContain("<strong>Safe</strong>");
    expect(rendered).not.toContain("javascript:");
    expect(rendered).not.toContain("<script");
  });

  it("wraps tables in a keyboard-scrollable region", () => {
    const rendered = renderSharedMarkdown(
      "| Provider | Approximate economics |\n| --- | --- |\n| Alchemy | $10.50/M |",
    );

    expect(rendered).toContain(
      '<bb-table-scroll role="region" aria-label="Scrollable table" tabindex="0"><table>',
    );
    expect(rendered).toContain("<th>Provider</th>");
    expect(rendered).toContain("<td>Alchemy</td>");
  });
});
