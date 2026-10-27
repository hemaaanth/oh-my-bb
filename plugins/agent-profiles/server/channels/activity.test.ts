import { describe, expect, it } from "vitest";
import { normalizeActivity } from "./activity";

describe("normalizeActivity", () => {
  it("keeps the latest meaningful line and drops provider noise", () => {
    expect(
      normalizeActivity(
        "warning: provider setting is deprecated\nUsing bb:catalogsearch\nLoaded config file /tmp/provider.toml",
      ),
    ).toBe("Using bb:catalogsearch");
  });

  it("returns null when a status contains only provider noise", () => {
    expect(normalizeActivity("warning: ignored\nReading config file provider.json")).toBeNull();
  });

  it("drops workspace setup lines", () => {
    expect(normalizeActivity("Preparing workspace\nUsing workspace: /home/me/.bb/homes/a")).toBeNull();
  });
});
