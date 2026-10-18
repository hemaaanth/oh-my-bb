import { describe, expect, it } from "vitest";
import { declaresImage, isPublicAddress, refusal, sniffImage } from "./webNet.js";

const bytes = (...values: number[]) => Uint8Array.from(values);
const text = (value: string) => new TextEncoder().encode(value);

describe("isPublicAddress", () => {
  it("allows public unicast only", () => {
    for (const ok of ["1.1.1.1", "93.184.216.34", "2606:4700::1111", "[2a00:1450::1]"]) expect(isPublicAddress(ok), ok).toBe(true);
    for (const bad of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "192.168.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "::ffff:127.0.0.1", "fc00::1", "fe80::1%en0", "2001:db8::1", "2002:7f00:1::", "localhost", "example.com"]) expect(isPublicAddress(bad), bad).toBe(false);
  });
});

describe("refusal", () => {
  it("allows plain https to public hosts", () => expect(refusal(new URL("https://upload.wikimedia.org/a.jpg"))).toBeNull());
  it("refuses other schemes, credentials, ports, private literals, and hosts off the list", () => {
    expect(refusal(new URL("http://example.com/a.png"))).toMatch(/https/);
    expect(refusal(new URL("file:///etc/passwd"))).toMatch(/https/);
    expect(refusal(new URL("https://u:p@example.com/"))).toMatch(/credentials/);
    expect(refusal(new URL("https://example.com:8443/"))).toMatch(/port/);
    expect(refusal(new URL("https://127.0.0.1/"))).toMatch(/public/);
    expect(refusal(new URL("https://[::1]/"))).toMatch(/public/);
    expect(refusal(new URL("https://evil.example/"), new Set(["photon.komoot.io"]))).toMatch(/allowed/);
  });
});

describe("sniffImage", () => {
  it("names image types by their leading bytes", () => {
    expect(sniffImage(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe("image/png");
    expect(sniffImage(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(sniffImage(text("GIF89a...."))).toBe("image/gif");
    expect(sniffImage(text("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniffImage(text('<?xml version="1.0"?>\n<svg xmlns="x"/>'))).toBe("image/svg+xml");
  });
  it("refuses what only claims to be an image", () => {
    expect(sniffImage(text("<!doctype html><html><body><svg></svg>"))).toBeNull();
    expect(sniffImage(bytes(0x89, 0x50))).toBeNull();
  });
  it("reads image Content-Types", () => {
    expect(declaresImage("image/svg+xml; charset=utf-8")).toBe(true);
    expect(declaresImage("text/html")).toBe(false);
    expect(declaresImage(undefined)).toBe(false);
  });
});
