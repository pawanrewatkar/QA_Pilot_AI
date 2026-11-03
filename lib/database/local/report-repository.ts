import { randomUUID } from "node:crypto";
import type { ListOptions, ReportBundleRecord, ReportFileRecord, ReportKind, ReportRecord } from "@/types";
import type { ReportBundleQuery, ReportFileLocation, ReportRepository } from "../provider";
import { ilike, jsonText } from "../sql/dialect";
import type { SqlExecutor, SqlValue } from "../sql/executor";
import { enqueueJob } from "./engine-repositories";

type Row = Record<string, unknown>;
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const clampLimit = (limit?: number, max = 500) => (!limit || limit < 1 ? 50 : Math.min(Math.floor(limit), max));
const likePattern = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const KIND_ORDER = ["PDF", "HTML", "TESTING_EXCEL", "BUG_EXCEL"];

export class LocalReportRepository implements ReportRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async list(options: ListOptions = {}): Promise<ReportRecord[]> {
    const conditions = [...(options.projectId ? ["rp.project_id = ?"] : []), ...(options.ownerId !== undefined ? ["p.owner_id = ?"] : [])];
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = await this.sql.all<Row>(`SELECT rp.*, p.name AS project_name FROM reports rp JOIN projects p ON p.id = rp.project_id ${where} ORDER BY rp.created_at DESC, rp.rowid DESC LIMIT ?`, [
      ...(options.projectId ? [options.projectId] : []),
      ...(options.ownerId !== undefined ? [options.ownerId] : []),
      clampLimit(options.limit, 1000),
    ]);
    return rows.map((row) => ({
      id: String(row.id),
      projectId: String(row.project_id),
      projectName: String(row.project_name),
      testRunId: str(row.test_run_id),
      format: String(row.format) as ReportRecord["format"],
      status: String(row.status) as ReportRecord["status"],
      fileName: str(row.file_name),
      sizeBytes: numOrNull(row.size_bytes),
      createdAt: String(row.created_at),
      completedAt: str(row.completed_at),
    }));
  }

  private where(q: ReportBundleQuery) {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (q.projectId) {
      where.push("b.project_id = ?");
      params.push(q.projectId);
    }
    if (q.ownerId !== undefined) {
      where.push("p.owner_id = ?");
      params.push(q.ownerId);
    }
    if (q.testRunId) {
      where.push("b.test_run_id = ?");
      params.push(q.testRunId);
    }
    if (q.status) {
      where.push("b.status = ?");
      params.push(q.status);
    }
    const search = q.search?.trim();
    if (search) {
      const p = likePattern(search);
      const like = ilike(this.sql);
      where.push(`(b.name ${like} ? ESCAPE '\\' OR b.website ${like} ? ESCAPE '\\' OR p.name ${like} ? ESCAPE '\\')`);
      params.push(p, p, p);
    }
    return { sql: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
  }

  private async mapBundles(rows: Row[]): Promise<ReportBundleRecord[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => String(r.id));
    const files = await this.sql.all<Row>(`SELECT * FROM reports WHERE bundle_id IN (${ids.map(() => "?").join(",")})`, ids);
    const byBundle = new Map<string, ReportFileRecord[]>();
    for (const f of files) {
      const list = byBundle.get(String(f.bundle_id)) ?? [];
      list.push({
        id: String(f.id),
        kind: str(f.kind) as ReportFileRecord["kind"],
        format: String(f.format) as ReportFileRecord["format"],
        status: String(f.status) as ReportFileRecord["status"],
        fileName: str(f.file_name),
        sizeBytes: numOrNull(f.size_bytes),
        errorMessage: str(f.error_message),
      });
      byBundle.set(String(f.bundle_id), list);
    }
    return rows.map((r) => ({
      id: String(r.id),
      projectId: String(r.project_id),
      projectName: String(r.project_name),
      testRunId: str(r.test_run_id),
      testRunName: str(r.run_name),
      name: String(r.name),
      website: String(r.website),
      status: String(r.status) as ReportBundleRecord["status"],
      errorMessage: str(r.error_message),
      createdAt: String(r.created_at),
      completedAt: str(r.completed_at),
      files: (byBundle.get(String(r.id)) ?? []).sort((a, b) => KIND_ORDER.indexOf(a.kind ?? "") - KIND_ORDER.indexOf(b.kind ?? "")),
    }));
  }

  private readonly bundleSelect = `SELECT b.*, p.name AS project_name, COALESCE(r.name, 'Run ' || substr(r.id, 1, 8)) AS run_name
    FROM report_bundles b JOIN projects p ON p.id = b.project_id LEFT JOIN test_runs r ON r.id = b.test_run_id`;

  async listBundles(q: ReportBundleQuery = {}): Promise<ReportBundleRecord[]> {
    const { sql, params } = this.where(q);
    const rows = await this.sql.all<Row>(`${this.bundleSelect} ${sql} ORDER BY b.created_at DESC, b.rowid DESC LIMIT ? OFFSET ?`, [...params, clampLimit(q.limit), Math.max(0, q.offset ?? 0)]);
    return this.mapBundles(rows);
  }

  async countBundles(q: ReportBundleQuery = {}): Promise<number> {
    const { sql, params } = this.where(q);
    return Number(((await this.sql.get<Row>(`SELECT COUNT(*) AS c FROM report_bundles b JOIN projects p ON p.id = b.project_id ${sql}`, params)) as Row).c);
  }

  async getBundle(id: string): Promise<ReportBundleRecord | null> {
    const row = await this.sql.get<Row>(`${this.bundleSelect} WHERE b.id = ?`, [id]);
    return row ? (await this.mapBundles([row]))[0] : null;
  }

  async requestBundle(testRunId: string, kinds?: ReportKind[]): Promise<ReportBundleRecord> {
    const run = await this.sql.get<Row>("SELECT r.id, r.name, r.status, r.project_id, p.name AS project_name, p.website_url FROM test_runs r JOIN projects p ON p.id = r.project_id WHERE r.id = ?", [testRunId]);
    if (!run) throw new Error("Test run not found");
    if (run.status === "PENDING" || run.status === "RUNNING") throw new Error("Reports can be generated once the run has finished.");
    const id = randomUUID();
    const ts = new Date().toISOString();
    const name = `${String(run.project_name)} — ${run.name ? String(run.name) : `Run ${String(run.id).slice(0, 8)}`}`;
    await this.sql.transaction(async (tx) => {
      await tx.run("INSERT INTO report_bundles (id, project_id, test_run_id, name, website, status, created_at) VALUES (?, ?, ?, ?, ?, 'GENERATING', ?)", [
        id,
        run.project_id as SqlValue,
        testRunId,
        name,
        run.website_url as SqlValue,
        ts,
      ]);
      // The payload names only the bundle so that recovery of a stopped worker never touches the run.
      await enqueueJob(tx, "report.generate", kinds ? { reportBundleId: id, kinds } : { reportBundleId: id });
    });
    return (await this.getBundle(id))!;
  }

  async deleteBundle(id: string): Promise<boolean> {
    return this.sql.transaction(async (tx) => {
      await tx.run(`UPDATE jobs SET status = 'CANCELLED', updated_at = ? WHERE status = 'PENDING' AND type = 'report.generate' AND ${jsonText(tx, "payload", "reportBundleId")} = ?`, [new Date().toISOString(), id]);
      await tx.run("DELETE FROM reports WHERE bundle_id = ?", [id]);
      return (await tx.run("DELETE FROM report_bundles WHERE id = ?", [id])).changes > 0;
    });
  }

  async getFile(bundleId: string, kind: string): Promise<ReportFileLocation | null> {
    const row = await this.sql.get<Row>("SELECT * FROM reports WHERE bundle_id = ? AND kind = ? AND status = 'READY'", [bundleId, kind]);
    if (!row || !row.storage_key) return null;
    return { storageKey: String(row.storage_key), fileName: String(row.file_name ?? "report"), kind: String(row.kind) as ReportFileLocation["kind"] };
  }
}
