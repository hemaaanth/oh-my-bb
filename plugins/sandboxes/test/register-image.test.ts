import { afterEach, describe, expect, it, vi } from "vitest";
import {
  daytonaSnapshotResources,
  ensureDaytonaRegistry,
} from "../src/register-image.js";

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function stubFetch(
  listed: Array<{ id: string; name: string; url: string }>,
): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: init?.method ?? "GET",
        body:
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as unknown)
            : null,
      });
      if ((init?.method ?? "GET") === "GET") {
        return Promise.resolve(
          new Response(JSON.stringify(listed), { status: 200 }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ id: "registry-1" }), { status: 201 }),
      );
    }),
  );
  return calls;
}

const target = { apiKey: "dt_key", sandboxClass: "container" as const };
const registry = { username: "octocat", password: "ghp_secret" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ensureDaytonaRegistry", () => {
  it("creates the registry entry for the reference's host", async () => {
    const calls = stubFetch([]);

    await ensureDaytonaRegistry({
      target,
      reference: "ghcr.io/acme/bb-sandbox@sha256:abc",
      registry,
    });

    expect(calls).toEqual([
      {
        url: "https://app.daytona.io/api/docker-registry",
        method: "GET",
        body: null,
      },
      {
        url: "https://app.daytona.io/api/docker-registry",
        method: "POST",
        body: {
          name: "bb-sandbox-ghcr.io",
          url: "ghcr.io",
          username: "octocat",
          password: "ghp_secret",
        },
      },
    ]);
  });

  it("patches the existing entry so rotated credentials take effect", async () => {
    const calls = stubFetch([
      { id: "reg-7", name: "bb-sandbox-ghcr.io", url: "ghcr.io" },
    ]);

    await ensureDaytonaRegistry({
      target: { ...target, apiUrl: "https://daytona.example/api/" },
      reference: "ghcr.io/acme/bb-sandbox@sha256:abc",
      registry,
    });

    expect(calls[1]).toEqual({
      url: "https://daytona.example/api/docker-registry/reg-7",
      method: "PATCH",
      body: {
        name: "bb-sandbox-ghcr.io",
        url: "ghcr.io",
        username: "octocat",
        password: "ghp_secret",
      },
    });
  });

  it("treats a single-segment repository as Docker Hub", async () => {
    const calls = stubFetch([]);

    await ensureDaytonaRegistry({
      target,
      reference: "bb-sandbox@sha256:abc",
      registry,
    });

    expect(calls[1]?.body).toMatchObject({
      name: "bb-sandbox-docker.io",
      url: "docker.io",
    });
  });

  it("fails loudly when the registry cannot be saved", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) =>
        Promise.resolve(
          (init?.method ?? "GET") === "GET"
            ? new Response("[]", { status: 200 })
            : new Response("nope", { status: 403 }),
        ),
      ),
    );

    await expect(
      ensureDaytonaRegistry({
        target,
        reference: "ghcr.io/acme/bb-sandbox@sha256:abc",
        registry,
      }),
    ).rejects.toThrow("HTTP 403");
  });
});

describe("daytonaSnapshotResources", () => {
  it("reserves enough storage for normal Linux VM project installs", () => {
    expect(daytonaSnapshotResources("linux-vm")).toEqual({
      cpu: 4,
      memory: 12,
      disk: 20,
    });
  });

  it("does not leave Linux containers on the unsafe 10 GB floor", () => {
    expect(daytonaSnapshotResources("container")).toEqual({
      cpu: 4,
      memory: 12,
      disk: 20,
    });
  });

  it("does not pretend a Linux image can become a Windows snapshot", () => {
    expect(() => daytonaSnapshotResources("windows")).toThrow(
      "must be captured from a Windows sandbox",
    );
  });
});
