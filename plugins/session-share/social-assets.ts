import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { initWasm, Resvg } from "@resvg/resvg-wasm";

const runtimeRequire = createRequire(import.meta.url);
let wasmReady: Promise<void> | undefined;

function pluginAssetUrl(filename: string): URL {
  const directory = new URL(".", import.meta.url);
  const path = new URL(`${directory.pathname.endsWith("/dist/") ? "../" : "./"}assets/${filename}`, import.meta.url);
  if (!existsSync(path)) throw new Error(`Session Share asset is missing: ${filename}`);
  return path;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function displayProjectName(projectName: string): string {
  const value = projectName.trim();
  return value.length > 48 ? `${value.slice(0, 47).trimEnd()}…` : value;
}

export const favicon = readFileSync(pluginAssetUrl("favicon-32x32.png"));
export const darkFavicon = readFileSync(
  pluginAssetUrl("favicon-32x32-dark.png"),
);
const interFont = readFileSync(pluginAssetUrl("inter.roman.var.ttf"));

export function renderOpenGraphSvg(projectName: string): string {
  const name = displayProjectName(projectName);
  const fontSize = name.length > 32 ? 50 : name.length > 22 ? 58 : 66;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#09090b"/>
  <text x="150" y="286" fill="#a1a1aa" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="28" font-weight="400">Shared session</text>
  <text x="150" y="372" fill="#e4e4e7" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="${fontSize}" font-weight="600" letter-spacing="-1.5">${escapeXml(name)}</text>
</svg>`;
}

export async function renderOpenGraphImage(projectName: string): Promise<Buffer> {
  await (wasmReady ??= initWasm(readFileSync(runtimeRequire.resolve("@resvg/resvg-wasm/index_bg.wasm"))));
  const renderer = new Resvg(renderOpenGraphSvg(projectName), {
    font: {
      defaultFontFamily: "Inter",
      fontBuffers: [interFont],
    },
  });
  try {
    const image = renderer.render();
    try {
      return Buffer.from(image.asPng());
    } finally {
      image.free();
    }
  } finally {
    renderer.free();
  }
}
