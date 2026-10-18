import { describe, expect, it } from "vitest";
import { spillSides } from "./kit.js";

describe("spillSides", () => {
  it("centers, borrows from the roomier side, and never passes the room", () => {
    expect(spillSides(-5, 100, 100)).toEqual({ left: 0, right: 0 });
    expect(spillSides(100, 200, 200)).toEqual({ left: 50, right: 50 });
    expect(spillSides(100, 10, 200)).toEqual({ left: 10, right: 90 });
    expect(spillSides(100, 200, 0)).toEqual({ left: 100, right: 0 });
    expect(spillSides(500, 100, 50)).toEqual({ left: 100, right: 50 });
    expect(spillSides(100, -20, 30)).toEqual({ left: 0, right: 30 });
  });
});
