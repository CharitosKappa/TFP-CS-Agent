import { getEnv } from "../env";
import { errInfo, log } from "../observability/logger";
import { graphFetch } from "./client";

// Microsoft Planner tasks for follow-ups/escalations that a human must action.
// App-only via the existing Graph app (Tasks.ReadWrite.All). No-ops gracefully
// when PLANNER_PLAN_ID isn't configured, so drafting never depends on it.

const NO_RETRY = { retries: 0 } as const;

/** A clickable link shown on the Planner task (alias instead of a raw long URL). */
export interface PlannerReference {
  url: string;
  alias: string;
}

/**
 * Planner reference-dictionary keys are the URL, but a few characters can't
 * appear in an OpenType JSON key and must be percent-encoded. `%` MUST be first
 * so already-encoded sequences in the URL (e.g. `%3D`) round-trip correctly.
 */
function plannerRefKey(url: string): string {
  return url
    .replace(/%/g, "%25")
    .replace(/\./g, "%2E")
    .replace(/:/g, "%3A")
    .replace(/@/g, "%40")
    .replace(/#/g, "%23");
}

/**
 * Sets a task's description (+ optional reference links). Task details is a
 * separate resource and needs If-Match. References render as clickable, aliased
 * links on the task, so a long Outlook deep-link shows as e.g. "Άνοιγμα draft".
 */
async function setTaskDetails(
  taskId: string,
  description: string,
  references?: PlannerReference[],
): Promise<void> {
  const res = await graphFetch(`/planner/tasks/${encodeURIComponent(taskId)}/details`);
  const etag = ((await res.json()) as { "@odata.etag"?: string })["@odata.etag"];
  if (!etag) return;
  const body: Record<string, unknown> = { description, previewType: "description" };
  if (references?.length) {
    const refs: Record<string, unknown> = {};
    for (const r of references) {
      refs[plannerRefKey(r.url)] = {
        "@odata.type": "#microsoft.graph.plannerExternalReference",
        alias: r.alias,
        type: "Other",
      };
    }
    body.references = refs;
  }
  await graphFetch(
    `/planner/tasks/${encodeURIComponent(taskId)}/details`,
    { method: "PATCH", headers: { "If-Match": etag }, body: JSON.stringify(body) },
    NO_RETRY,
  );
}

/**
 * Creates a Planner task in the configured plan/bucket. Best-effort: returns the
 * task id, or null when Planner isn't configured or creation fails (a Planner
 * outage must never block or fail the reply flow).
 */
export async function createPlannerTask(opts: {
  title: string;
  description?: string;
  /** ISO datetime for the task due date. */
  dueDate?: string;
  /** Clickable aliased links to attach (e.g. the Outlook draft). */
  references?: PlannerReference[];
}): Promise<string | null> {
  const env = getEnv();
  if (!env.PLANNER_PLAN_ID) return null; // Planner disabled

  try {
    const res = await graphFetch(
      `/planner/tasks`,
      {
        method: "POST",
        body: JSON.stringify({
          planId: env.PLANNER_PLAN_ID,
          ...(env.PLANNER_BUCKET_ID ? { bucketId: env.PLANNER_BUCKET_ID } : {}),
          title: opts.title.slice(0, 255),
          ...(opts.dueDate ? { dueDateTime: opts.dueDate } : {}),
        }),
      },
      NO_RETRY,
    );
    const task = (await res.json()) as { id: string };
    if (opts.description || opts.references?.length) {
      // Details failing shouldn't lose the task itself.
      await setTaskDetails(task.id, opts.description ?? "", opts.references).catch((e) =>
        log.warn("planner_details_failed", { ...errInfo(e) }),
      );
    }
    log.info("planner_task_created", { taskId: task.id });
    return task.id;
  } catch (e) {
    log.error("planner_task_failed", { ...errInfo(e) });
    return null;
  }
}

export interface PlannerTask {
  id: string;
  title: string;
  percentComplete: number;
}

/** Lists tasks in the configured plan. */
export async function listPlanTasks(): Promise<PlannerTask[]> {
  const env = getEnv();
  if (!env.PLANNER_PLAN_ID) return [];
  const res = await graphFetch(
    `/planner/plans/${encodeURIComponent(env.PLANNER_PLAN_ID)}/tasks?$select=id,title,percentComplete`,
  );
  return ((await res.json()) as { value: PlannerTask[] }).value ?? [];
}

/** Reads a task's notes/description (+ etag, needed to patch it back). */
export async function getTaskDetails(
  taskId: string,
): Promise<{ description: string; etag: string }> {
  const res = await graphFetch(`/planner/tasks/${encodeURIComponent(taskId)}/details`);
  const j = (await res.json()) as { description?: string; "@odata.etag"?: string };
  return { description: j.description ?? "", etag: j["@odata.etag"] ?? "" };
}

/** Appends a marker line to a task's notes (used to flag it as processed). */
export async function appendTaskNote(taskId: string, line: string): Promise<void> {
  const { description, etag } = await getTaskDetails(taskId);
  if (!etag || description.includes(line)) return;
  await graphFetch(
    `/planner/tasks/${encodeURIComponent(taskId)}/details`,
    { method: "PATCH", headers: { "If-Match": etag }, body: JSON.stringify({ description: `${description}\n${line}` }) },
    NO_RETRY,
  );
}

/** Verifies Planner access by reading the configured plan. */
export async function plannerHealthCheck(): Promise<Record<string, unknown>> {
  const env = getEnv();
  if (!env.PLANNER_PLAN_ID) return { configured: false };
  const res = await graphFetch(
    `/planner/plans/${encodeURIComponent(env.PLANNER_PLAN_ID)}?$select=id,title`,
  );
  const plan = (await res.json()) as { id: string; title: string };
  return { plan: plan.title, planId: plan.id, bucket: env.PLANNER_BUCKET_ID ?? "(default)" };
}
