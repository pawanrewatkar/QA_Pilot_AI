import type {
  ActivityRepository,
  BugRepository,
  CrawlRunRepository,
  DashboardRepository,
  DatabaseProvider,
  DocumentRepository,
  ExternalTestRepository,
  HistoryRepository,
  OwnedResource,
  OwnershipRepository,
  PageRepository,
  ProjectRepository,
  ReportRepository,
  TestCaseRepository,
  TestConfigurationRepository,
  TestResultRepository,
  TestRunRepository,
  WorkerRepository,
} from "./provider";

/** Thrown when a mutation targets a resource the identity does not own (or that does not exist). Callers treat it as 404. */
export class ResourceNotFoundError extends Error {
  constructor(resource: string) {
    super(`${resource} not found`);
    this.name = "ResourceNotFoundError";
  }
}

/**
 * The data access layer for one trusted owner (see lib/auth/identity.ts).
 *
 * It implements the whole DatabaseProvider interface on top of an unscoped provider:
 * - list, count and analytics queries get the owner filter injected (callers cannot remove it);
 * - id-based reads, updates, deletes and downloads first resolve the resource's owner through its parent
 *   chain (project → run → results/bugs/reports/files) and behave as "not found" for anything not owned;
 * - creations take the owner from the identity, never from request input.
 *
 * Because it implements the full interface, adding a repository method fails to compile until its access
 * rule is decided here. The unscoped provider stays available to the trusted worker and to tests only.
 */
export class OwnerScopedDatabaseProvider implements DatabaseProvider {
  readonly kind: DatabaseProvider["kind"];
  readonly projects: ProjectRepository;
  readonly documents: DocumentRepository;
  readonly testConfigurations: TestConfigurationRepository;
  readonly testRuns: TestRunRepository;
  readonly testResults: TestResultRepository;
  readonly crawlRuns: CrawlRunRepository;
  readonly workers: WorkerRepository;
  readonly pages: PageRepository;
  readonly testCases: TestCaseRepository;
  readonly bugs: BugRepository;
  readonly reports: ReportRepository;
  readonly history: HistoryRepository;
  readonly externalTests: ExternalTestRepository;
  readonly activity: ActivityRepository;
  readonly dashboard: DashboardRepository;
  readonly ownership: OwnershipRepository;

  constructor(
    private readonly base: DatabaseProvider,
    readonly ownerId: string,
  ) {
    if (typeof ownerId !== "string" || ownerId.trim() === "") throw new Error("An owner id is required for scoped data access.");
    const b = base;
    const owner = ownerId;
    const owns = async (resource: OwnedResource, id: string | null | undefined) => typeof id === "string" && id !== "" && (await b.ownership.ownerOf(resource, id)) === owner;
    const mustOwn = async (resource: OwnedResource, id: string | null | undefined, label: string) => {
      if (!(await owns(resource, id))) throw new ResourceNotFoundError(label);
    };

    this.kind = b.kind;
    this.ownership = b.ownership;
    this.workers = b.workers; // worker liveness only; contains no user data

    this.projects = {
      list: (q = {}) => b.projects.list({ ...q, ownerId: owner }),
      getById: async (id) => ((await owns("project", id)) ? b.projects.getById(id) : null),
      create: (input) => b.projects.create(input, owner),
      update: async (id, input) => ((await owns("project", id)) ? b.projects.update(id, input) : null),
      delete: async (id) => ((await owns("project", id)) ? b.projects.delete(id) : false),
      storagePrefixes: async (id) => ((await owns("project", id)) ? b.projects.storagePrefixes(id) : []),
      count: () => b.projects.count(owner),
    };

    this.documents = {
      listByProject: async (projectId) => ((await owns("project", projectId)) ? b.documents.listByProject(projectId) : []),
      getById: async (id) => ((await owns("document", id)) ? b.documents.getById(id) : null),
      create: async (input) => {
        await mustOwn("project", input.projectId, "Project");
        return b.documents.create(input);
      },
      delete: async (id) => ((await owns("document", id)) ? b.documents.delete(id) : false),
    };

    this.testConfigurations = {
      listByProject: async (projectId) => ((await owns("project", projectId)) ? b.testConfigurations.listByProject(projectId) : []),
      getById: async (id) => ((await owns("configuration", id)) ? b.testConfigurations.getById(id) : null),
      create: async (input) => {
        await mustOwn("project", input.projectId, "Project");
        return b.testConfigurations.create(input);
      },
      update: async (id, input) => ((await owns("configuration", id)) && (await owns("project", input.projectId)) ? b.testConfigurations.update(id, input) : null),
      delete: async (id) => ((await owns("configuration", id)) ? b.testConfigurations.delete(id) : false),
    };

    this.testRuns = {
      list: (o = {}) => b.testRuns.list({ ...o, ownerId: owner }),
      getById: async (id) => ((await owns("testRun", id)) ? b.testRuns.getById(id) : null),
      getDetail: async (id) => ((await owns("testRun", id)) ? b.testRuns.getDetail(id) : null),
      createAndEnqueue: async (input) => {
        await mustOwn("project", input.projectId, "Project");
        return b.testRuns.createAndEnqueue(input);
      },
      requestCancel: async (id) => ((await owns("testRun", id)) ? b.testRuns.requestCancel(id) : false),
      countsByRun: async (ids) => {
        const owned: string[] = [];
        for (const id of ids) if (await owns("testRun", id)) owned.push(id);
        return b.testRuns.countsByRun(owned);
      },
    };

    this.testResults = {
      listByRun: async (runId, q) => ((await owns("testRun", runId)) ? b.testResults.listByRun(runId, q) : []),
      countByRun: async (runId, q) => ((await owns("testRun", runId)) ? b.testResults.countByRun(runId, q) : 0),
      isKnownArtifact: async (key) => (await owns("storageKey", key)) && (await b.testResults.isKnownArtifact(key)),
      listDetails: async (runId, viewId, filters) => ((await owns("testRun", runId)) ? b.testResults.listDetails(runId, viewId, filters) : { rows: [], total: 0 }),
    };

    this.crawlRuns = {
      createAndEnqueue: async (projectId, startUrl, config) => {
        await mustOwn("project", projectId, "Project");
        return b.crawlRuns.createAndEnqueue(projectId, startUrl, config);
      },
      getById: async (id) => ((await owns("crawlRun", id)) ? b.crawlRuns.getById(id) : null),
      latest: async (projectId) => ((await owns("project", projectId)) ? b.crawlRuns.latest(projectId) : null),
      list: async (projectId, limit) => ((await owns("project", projectId)) ? b.crawlRuns.list(projectId, limit) : []),
      requestCancel: async (id) => ((await owns("crawlRun", id)) ? b.crawlRuns.requestCancel(id) : false),
    };

    this.pages = {
      list: (q = {}) => b.pages.list({ ...q, ownerId: owner }),
      count: (q = {}) => b.pages.count({ ...q, ownerId: owner }),
      getByIds: async (projectId, ids) => ((await owns("project", projectId)) ? b.pages.getByIds(projectId, ids) : []),
      setSelected: async (projectId, ids, selected) => ((await owns("project", projectId)) ? b.pages.setSelected(projectId, ids, selected) : 0),
      addManual: async (projectId, url, normalizedUrl) => {
        await mustOwn("project", projectId, "Project");
        return b.pages.addManual(projectId, url, normalizedUrl);
      },
      remove: async (projectId, ids) => ((await owns("project", projectId)) ? b.pages.remove(projectId, ids) : 0),
    };

    this.testCases = { list: (o = {}) => b.testCases.list({ ...o, ownerId: owner }) };

    this.bugs = {
      list: (q = {}) => b.bugs.list({ ...q, ownerId: owner }),
      count: (q = {}) => b.bugs.count({ ...q, ownerId: owner }),
      facets: (projectId) => b.bugs.facets(projectId, owner),
      getDetail: async (id) => ((await owns("bug", id)) ? b.bugs.getDetail(id) : null),
      related: async (id) => ((await owns("bug", id)) ? b.bugs.related(id) : []),
      updateStatus: async (id, status, note) => ((await owns("bug", id)) ? b.bugs.updateStatus(id, status, note) : null),
      createFromRun: async (runId) => {
        await mustOwn("testRun", runId, "Test run");
        return b.bugs.createFromRun(runId);
      },
    };

    this.reports = {
      list: (o = {}) => b.reports.list({ ...o, ownerId: owner }),
      listBundles: (q = {}) => b.reports.listBundles({ ...q, ownerId: owner }),
      countBundles: (q = {}) => b.reports.countBundles({ ...q, ownerId: owner }),
      getBundle: async (id) => ((await owns("reportBundle", id)) ? b.reports.getBundle(id) : null),
      requestBundle: async (testRunId, kinds) => {
        await mustOwn("testRun", testRunId, "Test run");
        return b.reports.requestBundle(testRunId, kinds);
      },
      deleteBundle: async (id) => ((await owns("reportBundle", id)) ? b.reports.deleteBundle(id) : false),
      getFile: async (bundleId, kind) => ((await owns("reportBundle", bundleId)) ? b.reports.getFile(bundleId, kind) : null),
    };

    this.history = {
      listRuns: (q = {}) => b.history.listRuns({ ...q, ownerId: owner }),
      countRuns: (q = {}) => b.history.countRuns({ ...q, ownerId: owner }),
      getRun: async (id) => ((await owns("testRun", id)) ? b.history.getRun(id) : null),
      previousRunId: async (runId) => ((await owns("testRun", runId)) ? b.history.previousRunId(runId) : null),
      comparableRuns: async (runId) => ((await owns("testRun", runId)) ? b.history.comparableRuns(runId) : []),
      compare: async (currentId, previousId) => ((await owns("testRun", currentId)) && (await owns("testRun", previousId)) ? b.history.compare(currentId, previousId) : null),
    };

    this.externalTests = {
      create: async (input) => {
        await mustOwn("project", input.projectId, "Project");
        return b.externalTests.create(input);
      },
      get: async (runId) => ((await owns("testRun", runId)) ? b.externalTests.get(runId) : null),
      list: (q = {}) => b.externalTests.list({ ...q, ownerId: owner }),
      count: (q = {}) => b.externalTests.count({ ...q, ownerId: owner }),
      listCases: async (runId, q) => ((await owns("testRun", runId)) ? b.externalTests.listCases(runId, q) : { rows: [], total: 0 }),
      getOutputFile: async (runId) => ((await owns("testRun", runId)) ? b.externalTests.getOutputFile(runId) : null),
    };

    this.activity = {
      record: async (entry) => {
        // An entry about a project must be about one of the owner's projects (deleted projects pass null).
        if (entry.projectId) await mustOwn("project", entry.projectId, "Project");
        return b.activity.record({ ...entry, ownerId: owner });
      },
      list: (o = {}) => b.activity.list({ ...o, ownerId: owner }),
    };

    this.dashboard = {
      getMetrics: () => b.dashboard.getMetrics(owner),
      getResultTrend: (days) => b.dashboard.getResultTrend(days, owner),
      getRegressions: (limit) => b.dashboard.getRegressions(limit, owner),
    };
  }

  healthCheck() {
    return this.base.healthCheck();
  }

  /** The underlying connection is shared by the process; a scoped view never closes it. */
  async close(): Promise<void> {}
}
