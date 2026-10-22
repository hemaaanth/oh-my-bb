import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";

// ZIP's stored method needs no archiver executable on the user's machine.
export async function browserExtensionZip(): Promise<Buffer> {
  const files = ["manifest.json", "background.js", "relay.js", "page-operations.js", "options.html", "options.js", "popup.html", "popup.js", "extension.css", "inter.woff2", "Inter-OFL.txt", "bb.svg", "icons/16.png", "icons/32.png", "icons/48.png", "icons/128.png", "THIRD-PARTY-NOTICES"];
  const entries: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file);
    const body = await readFile(join(dirname(fileURLToPath(import.meta.url)), file === "THIRD-PARTY-NOTICES" ? ".." : "../browser-extension", file));
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(33, 12);
    header.writeUInt32LE(crc32(body), 14); header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(body.length, 22); header.writeUInt16LE(name.length, 26);
    entries.push(header, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(33, 14);
    central.writeUInt32LE(crc32(body), 16); central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    directory.push(central, name);
    offset += header.length + name.length + body.length;
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...entries, central, end]);
}

export async function browserExtensionOrigin(): Promise<string> {
  const manifest = JSON.parse(await readFile(join(dirname(fileURLToPath(import.meta.url)), "../browser-extension/manifest.json"), "utf8"));
  const id = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0, 32)
    .replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + parseInt(digit, 16)));
  return `chrome-extension://${id}`;
}
