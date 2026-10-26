import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { publicSourcePath } from "./build.mjs";

const root = resolve(tmpdir(), "sidebar-package-fixture");

describe("public source-map paths", () => {
  it("removes machine paths from virtual dependency sources and retains package-relative sources", () => {
    const virtual = `bb-zod-locale-stub:${join(root, "node_modules", "zod", "v4", "locales", "index.js")}`;
    expect(publicSourcePath(virtual, root)).toBe("bb-zod-locale-stub:node_modules/zod/v4/locales/index.js");
    expect(publicSourcePath(join(root, "server.ts"), root)).toBe("../server.ts");
    expect(publicSourcePath("../../server.ts", root)).toBe("../../server.ts");
  });

  it("does not retain an external machine directory", () => {
    const external = resolve(tmpdir(), "other-machine-fixture", "generated.ts");
    expect(publicSourcePath(external, root)).toBe("../external/generated.ts");
  });
});
