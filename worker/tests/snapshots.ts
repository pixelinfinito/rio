import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Env, Snapshot } from "../src/types";
import { MemorySnapshot, compareUtf8, indexKey } from "../src/snapshot";
import { seal, storeChunk, storePack } from "../src/upload";
export const hex = (bytes: Uint8Array) => bytesToHex(blake3(bytes));
/** The canonical manifest and the distinct contents of a snapshot, as the CLI builds them. */
export function manifestOf(snapshot: Snapshot) {
  const contents = new Map<string, Uint8Array>();
  const lines: string[] = [];
  for (const version of ["base", "head"] as const)
    for (const path of Object.keys(snapshot[version]).sort(compareUtf8)) {
      const file = snapshot[version][path];
      const bytes = MemorySnapshot.bytes(file);
      const hash = hex(bytes);
      contents.set(hash, bytes);
      lines.push(
        JSON.stringify({
          version,
          path,
          hash,
          mode: file.mode,
          size: bytes.length,
        }) + "\n",
      );
    }
  const manifest = new TextEncoder().encode(lines.join(""));
  return { id: hex(manifest), manifest, contents, lines };
}
/** Pack body: u32 big-endian index length, index JSON, contents in order. */
export function packBody(entries: [string, Uint8Array][]): Uint8Array {
  const index = new TextEncoder().encode(
    JSON.stringify(entries.map(([hash, b]) => ({ hash, size: b.length }))),
  );
  const size = entries.reduce((n, [, b]) => n + b.length, 0);
  const body = new Uint8Array(4 + index.length + size);
  new DataView(body.buffer).setUint32(0, index.length);
  body.set(index, 4);
  let offset = 4 + index.length;
  for (const [, b] of entries) {
    body.set(b, offset);
    offset += b.length;
  }
  return body;
}
/** Stores and seals a snapshot through the endpoint's upload code. */
export async function storeSnapshot(
  env: Env,
  snapshot: Snapshot,
  tenant = "owner",
  options: { pack?: number; chunk?: number } = {},
): Promise<{ id: string; key: string; packs: number; chunks: number }> {
  const { id, contents, lines } = manifestOf(snapshot);
  const packLimit = options.pack ?? 7 * 1024 * 1024,
    chunkLimit = options.chunk ?? 8 * 1024 * 1024;
  let pack: [string, Uint8Array][] = [],
    size = 0,
    packs = 0;
  const flush = async () => {
    if (pack.length) await storePack(env, tenant, packBody(pack));
    packs += pack.length ? 1 : 0;
    pack = [];
    size = 0;
  };
  for (const entry of contents) {
    if (size + entry[1].length > packLimit) await flush();
    pack.push(entry);
    size += entry[1].length;
  }
  await flush();
  const chunks = chunked(lines, chunkLimit);
  for (const [n, chunk] of chunks.entries())
    await storeChunk(env, tenant, id, n, chunk);
  await seal(env, tenant, id, { chunks: chunks.length });
  return { id, key: indexKey(tenant, id), packs, chunks: chunks.length };
}
/** Manifest lines grouped into chunks of whole lines below the byte limit. */
export function chunked(lines: string[], limit: number): Uint8Array[] {
  const chunks: string[] = [""];
  for (const line of lines) {
    if (chunks.at(-1)!.length && chunks.at(-1)!.length + line.length > limit)
      chunks.push("");
    chunks[chunks.length - 1] += line;
  }
  return chunks.map((c) => new TextEncoder().encode(c));
}
type Request = (
  path: string,
  method: string,
  body: BodyInit | undefined,
) => Promise<Response>;
/** Uploads a snapshot over HTTP, returning the seal response. */
export async function uploadSnapshot(
  request: Request,
  snapshot: Snapshot,
): Promise<Response> {
  const { id, manifest, contents } = manifestOf(snapshot);
  const missing = await request(
    "/v1/contents/missing",
    "POST",
    JSON.stringify({ hashes: [...contents.keys()] }),
  );
  if (!missing.ok) return missing;
  const wanted = ((await missing.json()) as any).missing as string[];
  if (wanted.length) {
    const pack = await request(
      "/v1/packs",
      "PUT",
      packBody(wanted.map((h) => [h, contents.get(h)!])),
    );
    if (!pack.ok) return pack;
  }
  const chunk = await request(`/v1/manifests/${id}/chunks/0`, "PUT", manifest);
  if (!chunk.ok) return chunk;
  return request(
    `/v1/manifests/${id}/seal`,
    "POST",
    JSON.stringify({ chunks: 1 }),
  );
}
/** Parses the executor input: the JSON header line and the tar members. */
export async function readJobInput(stream: ReadableStream<Uint8Array>) {
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  const newline = bytes.indexOf(10);
  const header = JSON.parse(
    new TextDecoder().decode(bytes.subarray(0, newline)),
  );
  const files: Record<string, { mode: number; bytes: Uint8Array }> = {};
  const text = (b: Uint8Array) =>
    new TextDecoder().decode(b).replace(/\0.*$/s, "");
  let offset = newline + 1,
    pax: string | undefined;
  while (offset + 512 <= bytes.length) {
    const block = bytes.subarray(offset, offset + 512);
    if (block.every((b) => b === 0)) break;
    const size = parseInt(text(block.subarray(124, 136)), 8);
    const type = String.fromCharCode(block[156]);
    const body = bytes.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      pax = /\d+ path=([\s\S]*)\n$/.exec(new TextDecoder().decode(body))![1];
      continue;
    }
    if (type !== "0") throw new Error(`unexpected tar member type ${type}`);
    files[pax ?? text(block.subarray(0, 100))] = {
      mode: parseInt(text(block.subarray(100, 108)), 8),
      bytes: body,
    };
    pax = undefined;
  }
  return { header, files };
}
/** The tree of one version in an executor input, in the in-memory file shape. */
export function treeOf(
  files: Record<string, { mode: number; bytes: Uint8Array }>,
  version: "base" | "head",
) {
  return Object.fromEntries(
    Object.entries(files)
      .filter(([name]) => name.startsWith(`${version}/`))
      .map(([name, f]) => [
        name.slice(version.length + 1),
        {
          mode: f.mode === 0o755 ? 0o100755 : 0o100644,
          content: new TextDecoder().decode(f.bytes),
        },
      ]),
  );
}
