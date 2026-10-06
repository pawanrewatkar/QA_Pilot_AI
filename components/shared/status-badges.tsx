import { Badge, type BadgeProps } from "@/components/ui/badge";
import type { BugSeverity, BugStatus, ReportStatus, TestResultStatus, TestRunStatus } from "@/types";

type Variant = NonNullable<BadgeProps["variant"]>;

const RUN_STATUS: Record<TestRunStatus, Variant> = {
  PENDING: "muted",
  RUNNING: "default",
  COMPLETED: "success",
  FAILED: "destructive",
  CANCELLED: "secondary",
};

const RESULT_STATUS: Record<TestResultStatus, Variant> = {
  PASS: "success",
  FAIL: "destructive",
  WARNING: "warning",
  "NOT EXECUTED": "muted",
  "NOT APPLICABLE": "secondary",
};

const SEVERITY: Record<BugSeverity, Variant> = {
  CRITICAL: "destructive",
  HIGH: "warning",
  MEDIUM: "default",
  LOW: "secondary",
};

const BUG_STATUS: Record<BugStatus, Variant> = {
  OPEN: "destructive",
  IN_PROGRESS: "default",
  RESOLVED: "success",
  CLOSED: "secondary",
  WONT_FIX: "muted",
};

const REPORT_STATUS: Record<ReportStatus, Variant> = {
  GENERATING: "default",
  READY: "success",
  FAILED: "destructive",
};

const label = (s: string) => s.replace(/_/g, " ");

export const RunStatusBadge = ({ status }: { status: TestRunStatus }) => <Badge variant={RUN_STATUS[status]}>{label(status)}</Badge>;
export const ResultStatusBadge = ({ status }: { status: TestResultStatus }) => <Badge variant={RESULT_STATUS[status]}>{status}</Badge>;
export const SeverityBadge = ({ severity }: { severity: BugSeverity }) => <Badge variant={SEVERITY[severity]}>{severity}</Badge>;
export const BugStatusBadge = ({ status }: { status: BugStatus }) => <Badge variant={BUG_STATUS[status]}>{label(status)}</Badge>;
export const ReportStatusBadge = ({ status }: { status: ReportStatus }) => <Badge variant={REPORT_STATUS[status]}>{status}</Badge>;
