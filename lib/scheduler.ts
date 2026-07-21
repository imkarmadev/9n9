import cron, { type ScheduledTask } from "node-cron";
import { executeWorkflow } from "./executor";
import { listWorkflows } from "./repository";

type SchedulerGlobal = typeof globalThis & {
  __n9nScheduleTasks?: Map<string, ScheduledTask>;
  __n9nSchedulerReady?: boolean;
};

const schedulerGlobal = globalThis as SchedulerGlobal;

function tasks() {
  schedulerGlobal.__n9nScheduleTasks ??= new Map();
  return schedulerGlobal.__n9nScheduleTasks;
}

export function refreshSchedules() {
  for (const task of tasks().values()) task.stop();
  tasks().clear();

  for (const workflow of listWorkflows().filter((item) => item.enabled)) {
    const trigger = workflow.graph.nodes.find(
      (node) => node.data.kind === "trigger.schedule",
    );
    const expression = String(trigger?.data.config.cron ?? "");

    if (!expression || !cron.validate(expression)) continue;

    const task = cron.schedule(expression, async () => {
      try {
        await executeWorkflow(workflow.id, "schedule", {
          scheduledAt: new Date().toISOString(),
        });
      } catch (error) {
        console.error("9n9 schedule failed", workflow.id, error);
      }
    });

    tasks().set(workflow.id, task);
  }
}

export function initializeScheduler() {
  if (schedulerGlobal.__n9nSchedulerReady) return;
  schedulerGlobal.__n9nSchedulerReady = true;
  refreshSchedules();
}
