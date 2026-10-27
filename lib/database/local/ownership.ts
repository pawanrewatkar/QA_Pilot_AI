import type { OwnedResource, OwnershipRepository } from "../provider";
import type { SqliteDatabase } from "./sqlite-client";

/**
 * Ownership is stored once, on `projects.owner_id`. Every other resource reaches its project either
 * directly (`project_id`) or through its test run, so ownership is resolved along that parent chain.
 */

/** SQL fragment restricting `<column>` (a project id) to the owner's projects. Bind the owner id once. */
export const ownedProjectIds = (column: string) => `${column} IN (SELECT id FROM projects WHERE owner_id = ?)`;
/** SQL fragment restricting `<column>` (a test run id) to runs of the owner's projects. Bind the owner id once. */
export const ownedRunIds = (column: string) => `${column} IN (SELECT r.id FROM test_runs r JOIN projects p ON p.id = r.project_id WHERE p.owner_id = ?)`;

type Row = { owner_id: string | null } | undefined;

/** Storage keys whose first segments identify the owning resource. Anything else has no owner. */
function keyOwnerQuery(key: string): { sql: string; id: string } | null {
  const [root, id] = key.split("/");
  if (!id) return null;
  switch (root) {
    case "runs":
      return { sql: "SELECT p.owner_id FROM test_runs r JOIN projects p ON p.id = r.project_id WHERE r.id = ?", id };
    case "reports":
      return { sql: "SELECT p.owner_id FROM report_bundles b JOIN projects p ON p.id = b.project_id WHERE b.id = ?", id };
    case "projects":
      return { sql: "SELECT owner_id FROM projects WHERE id = ?", id };
    default:
      return null;
  }
}

const QUERIES: Record<Exclude<OwnedResource, "storageKey">, string> = {
  project: "SELECT owner_id FROM projects WHERE id = ?",
  configuration: "SELECT p.owner_id FROM test_configurations c JOIN projects p ON p.id = c.project_id WHERE c.id = ?",
  document: "SELECT p.owner_id FROM documents d JOIN projects p ON p.id = d.project_id WHERE d.id = ?",
  testRun: "SELECT p.owner_id FROM test_runs r JOIN projects p ON p.id = r.project_id WHERE r.id = ?",
  crawlRun: "SELECT p.owner_id FROM crawl_runs c JOIN projects p ON p.id = c.project_id WHERE c.id = ?",
  bug: "SELECT p.owner_id FROM bugs b JOIN projects p ON p.id = b.project_id WHERE b.id = ?",
  reportBundle: "SELECT p.owner_id FROM report_bundles b JOIN projects p ON p.id = b.project_id WHERE b.id = ?",
};

export class LocalOwnershipRepository implements OwnershipRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async ownerOf(resource: OwnedResource, id: string): Promise<string | null> {
    if (typeof id !== "string" || !id) return null;
    if (resource === "storageKey") {
      const q = keyOwnerQuery(id);
      if (!q) return null;
      return (this.db.prepare(q.sql).get(q.id) as Row)?.owner_id ?? null;
    }
    return (this.db.prepare(QUERIES[resource]).get(id) as Row)?.owner_id ?? null;
  }
}
