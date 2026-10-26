import { describe, expect, it, vi } from "vitest";
import {
  approvedNavigationUrl,
  formatPublicProxyError,
  hostFetchUrl,
  pinpointPickPayloadSchema,
  retryPreviewHostBusy,
} from "./server.js";
import {
  MAX_RESPONSE_BYTES,
  responseReservationBytes,
} from "./host.js";

describe("session share target routing", () => {
  it("bypasses the BB Connect gate for a canonical port-share URL", () => {
    expect(
      hostFetchUrl(new URL("https://preview--5173.getbb.app/docs?q=pinpoint"))
        .href,
    ).toBe("http://127.0.0.1:5173/docs?q=pinpoint");
  });

  it("keeps ordinary remote targets on their original origin", () => {
    expect(hostFetchUrl(new URL("https://example.com/docs")).href).toBe(
      "https://example.com/docs",
    );
  });

  it("does not translate lookalike hosts to environment loopback", () => {
    for (const url of [
      "https://docs--3000.attacker.example/",
      "https://getbb.app.attacker.example/",
      "http://preview--5173.getbb.app/",
      "https://preview--99999.getbb.app/",
    ]) {
      expect(hostFetchUrl(new URL(url)).href).toBe(url);
    }
  });


  it("retries transient preview-host contention", async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(
        new Error("Shared preview host is busy; retry the request."),
      )
      .mockRejectedValueOnce(
        new Error("Shared preview host is busy; retry the request."),
      )
      .mockResolvedValue("loaded");
    const waits: number[] = [];
    const wait = vi.fn(async (milliseconds: number) => {
      waits.push(milliseconds);
    });

    await expect(retryPreviewHostBusy(operation, wait)).resolves.toBe("loaded");
    expect(operation).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([50, 150]);
  });

  it("reserves declared response bytes for small assets", () => {
    expect(
      responseReservationBytes(
        new Response(null, { headers: { "content-length": "4096" } }),
      ),
    ).toBe(4096);
    expect(responseReservationBytes(new Response(null))).toBe(
      MAX_RESPONSE_BYTES,
    );
  });

  it("accepts the nullable fields emitted by the public Pinpoint client", () => {
    expect(
      pinpointPickPayloadSchema.parse({
        url: "https://example.com/",
        comment: "Tighten this copy",
        selectedText: null,
      }).selectedText,
    ).toBeNull();
  });

  it("accepts same-origin navigation and rejects origin changes", () => {
    expect(
      approvedNavigationUrl(
        "https://preview--5173.getbb.app/",
        "https://preview--5173.getbb.app/settings",
      ).href,
    ).toBe("https://preview--5173.getbb.app/settings");
    expect(() =>
      approvedNavigationUrl(
        "https://preview--5173.getbb.app/",
        "https://example.com/escape",
      ),
    ).toThrow("left the approved origin");
  });
});
