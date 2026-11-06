import type { Env, Execution, Version } from "./types";
import { invariant } from "./validation";
import { SYMLINK, StoredSnapshot } from "./snapshot";
const encoder = new TextEncoder();
const BLOCK = 512;
function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, "0") + "\0";
}
function header(name: Uint8Array, size: number, mode: number, type: string) {
  const block = new Uint8Array(BLOCK);
  const put = (offset: number, text: string | Uint8Array) =>
    block.set(typeof text === "string" ? encoder.encode(text) : text, offset);
  put(0, name.subarray(0, 100));
  put(100, octal(mode, 8));
  put(108, octal(0, 8));
  put(116, octal(0, 8));
  put(124, octal(size, 12));
  put(136, octal(0, 12));
  put(148, "        ");
  put(156, type);
  put(257, "ustar\0");
  put(263, "00");
  let sum = 0;
  for (const byte of block) sum += byte;
  put(148, sum.toString(8).padStart(6, "0") + "\0 ");
  return block;
}
const padding = (size: number) =>
  new Uint8Array((BLOCK - (size % BLOCK)) % BLOCK);
/** PAX record "<length> path=<name>\n", where length counts itself. */
function paxPath(name: Uint8Array): Uint8Array {
  const body = new Uint8Array([...encoder.encode(" path="), ...name, 10]);
  let length = body.length + 1;
  while (String(length).length + body.length !== length) length++;
  return new Uint8Array([...encoder.encode(String(length)), ...body]);
}
/** Tar member blocks before a file's content. */
export function memberHeader(path: string, size: number, mode: number) {
  const name = encoder.encode(path);
  const parts: Uint8Array[] = [];
  if (name.length > 100 || /[^\x20-\x7e]/.test(path)) {
    const pax = paxPath(name);
    parts.push(
      header(encoder.encode("././@PaxHeader"), pax.length, 0o644, "x"),
    );
    parts.push(pax, padding(pax.length));
  }
  parts.push(header(name, size, mode, "0"));
  return parts;
}
/** Versions a job reads: run jobs their own tree; analysis jobs both. */
export function needs(kind: Execution["kind"], version: Version): Version[] {
  return kind === "run" ? [version] : ["base", "head"];
}
export async function snapshotFor(
  env: Env,
  job: Execution,
): Promise<StoredSnapshot> {
  // The snapshot is resolved through the review's tenant, never from the job alone.
  const row = await env.DB.prepare(
    "SELECT s.object_key FROM snapshots s JOIN reviews r ON r.tenant=s.tenant WHERE r.id=? AND s.id=?",
  )
    .bind(job.review_id, job.snapshot_id)
    .first<{ object_key: string }>();
  invariant(row, "snapshot not found");
  return StoredSnapshot.open(env, row.object_key);
}
/**
 * The executor's standard input: one JSON header line (the job plus its symbolic
 * links) and a tar archive of the needed trees. It is produced on demand, so no
 * tree is ever buffered whole.
 */
export async function jobInput(
  env: Env,
  job: Execution,
): Promise<ReadableStream<Uint8Array>> {
  const snapshot = await snapshotFor(env, job);
  const links: Partial<Record<Version, Record<string, string>>> = {};
  for (const version of job.needs)
    links[version] = await snapshot.links(version);
  const head = encoder.encode(JSON.stringify({ ...job, links }) + "\n");
  async function* chunks(): AsyncGenerator<Uint8Array> {
    yield head;
    for (const version of job.needs) {
      const tree = snapshot[version];
      for await (const batch of tree.batches((e) => e.mode !== SYMLINK))
        for (const [entry, bytes] of batch) {
          const mode = entry.mode === 0o100755 ? 0o755 : 0o644;
          yield* memberHeader(`${version}/${entry.path}`, entry.size, mode);
          if (bytes) yield bytes;
          else {
            // Large contents stream straight from storage.
            const reader = (await tree.stream(entry)).getReader();
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              yield value;
            }
          }
          yield padding(entry.size);
        }
    }
    yield new Uint8Array(BLOCK * 2);
  }
  const iterator = chunks();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await iterator.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    async cancel() {
      await iterator.return(undefined);
    },
  });
}
