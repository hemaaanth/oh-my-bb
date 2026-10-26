import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";

it("uses only public SDK contracts and package-local source", async () => {
  const scan = await experimental_scanPublicSdkOnly(fileURLToPath(new URL(".", import.meta.url)), {
    allow: [/^react(?:-dom)?(?:\/.*)?$/, /^@radix-ui\//, /^@hugeicons\//, /^@testing-library\//, /^(?:sonner|class-variance-authority|clsx|tailwind-merge|vitest)(?:\/.*)?$/, /^@\//],
  });
  expect(scan.violations).toEqual([]);
  expect(scan.privateDependencies).toEqual([]);
});
