import { experimental_scanPublicSdkOnly } from '@get-bb/plugin-sdk/testing';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('uses only public SDK and package-local imports', () => {
  const result = experimental_scanPublicSdkOnly(fileURLToPath(new URL('../', import.meta.url)), {
    allow: [/^(?:react(?:-dom)?(?:\/.*)?|vitest(?:\/config)?|@testing-library\/react|@radix-ui\/react-slot|class-variance-authority|clsx|tailwind-merge)$/],
  });
  expect(result.violations).toEqual([]);
  expect(result.privateDependencies).toEqual([]);
});
