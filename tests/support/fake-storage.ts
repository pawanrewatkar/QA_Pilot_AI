/** A minimal fake of the Supabase Storage HTTP API on 127.0.0.1 (shared by the storage and worker lifecycle tests). */
import http from "node:http";
import type { AddressInfo } from "node:net";

export const SECRET = "sb_secret_test_only_0123456789abcdef"; // a fake key; never a real credential
export const BUCKET = "qa-test-bucket";

export interface Recorded {
  method: string;
  path: string;
  apikey?: string;
  authorization?: string;
  contentType?: string;
  upsert?: string;
}

/** A minimal fake of the Supabase Storage API (upload, download, HEAD, remove, list) for one private bucket. */
export class FakeStorageServer {
  objects = new Map<string, { bytes: Buffer; contentType: string }>();
  requests: Recorded[] = [];
  /** Status codes to answer the next requests with, before handling them normally. */
  failNext: number[] = [];
  private server = http.createServer((req, res) => void this.handle(req, res));
  url = "";

  async start() {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  stop() {
    return new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url ?? "/", "http://x");
    this.requests.push({
      method: req.method ?? "",
      path: decodeURIComponent(url.pathname),
      apikey: req.headers.apikey as string | undefined,
      authorization: req.headers.authorization,
      contentType: req.headers["content-type"],
      upsert: req.headers["x-upsert"] as string | undefined,
    });
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    const fail = this.failNext.shift();
    if (fail) return json(fail, { statusCode: String(fail), error: "injected", message: `Injected ${fail}` });
    if (req.headers.apikey !== SECRET) return json(403, { statusCode: "403", error: "Unauthorized", message: "Invalid key" });
    const p = decodeURIComponent(url.pathname);
    const prefix = `/storage/v1/object/${BUCKET}/`;
    const notFound = () => (req.method === "HEAD" ? (res.writeHead(400), res.end()) : json(400, { statusCode: "404", error: "not_found", message: "Object not found" }));
    if (req.method === "POST" && p === `/storage/v1/object/list/${BUCKET}`) {
      const { prefix: folder, limit, offset } = JSON.parse(body.toString()) as { prefix: string; limit: number; offset: number };
      const base = folder ? `${folder}/` : "";
      const names = new Map<string, string | null>();
      for (const key of this.objects.keys()) {
        if (!key.startsWith(base)) continue;
        const rest = key.slice(base.length);
        const [first, ...more] = rest.split("/");
        names.set(first, more.length ? null : `id-${first}`);
      }
      const entries = [...names].sort(([a], [b]) => a.localeCompare(b)).map(([name, id]) => ({ name, id }));
      return json(200, entries.slice(offset, offset + limit));
    }
    if (req.method === "DELETE" && p === `/storage/v1/object/${BUCKET}`) {
      const { prefixes } = JSON.parse(body.toString()) as { prefixes: string[] };
      const removed = prefixes.filter((k) => this.objects.delete(k)).map((name) => ({ name }));
      return json(200, removed);
    }
    if (!p.startsWith(prefix)) return json(404, { statusCode: "404", error: "not_found", message: "Bucket not found" });
    const key = p.slice(prefix.length);
    if (req.method === "POST") {
      if (this.objects.has(key) && req.headers["x-upsert"] !== "true") return json(400, { statusCode: "409", error: "Duplicate", message: "The resource already exists" });
      this.objects.set(key, { bytes: body, contentType: String(req.headers["content-type"]) });
      return json(200, { Key: `${BUCKET}/${key}`, Id: "id" });
    }
    const object = this.objects.get(key);
    if (!object) return notFound();
    if (req.method === "HEAD") return (res.writeHead(200), res.end());
    res.writeHead(200, { "content-type": object.contentType });
    res.end(object.bytes);
  }
}
