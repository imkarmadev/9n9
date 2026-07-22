"use client";

import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import {
  Braces,
  Clock3,
  Code2,
  GitBranch,
  Globe2,
  MousePointerClick,
  PanelsTopLeft,
  StickyNote,
  Webhook,
} from "lucide-react";
import type { WorkflowNodeData } from "@/lib/types";

export type N9nFlowNode = Node<WorkflowNodeData, "n9n">;

const icons = {
  "trigger.manual": MousePointerClick,
  "trigger.webhook": Webhook,
  "trigger.schedule": Clock3,
  "action.codex": Code2,
  "action.http": Globe2,
  "data.compose": Braces,
  "logic.condition": GitBranch,
  "annotation.group": PanelsTopLeft,
  "annotation.sticky": StickyNote,
};

const kindNames = {
  "trigger.manual": "MANUAL",
  "trigger.webhook": "WEBHOOK",
  "trigger.schedule": "SCHEDULE",
  "action.codex": "LOCAL CODEX",
  "action.http": "HTTP",
  "data.compose": "COMPOSE",
  "logic.condition": "CONDITION",
  "annotation.group": "GROUP",
  "annotation.sticky": "NOTE",
};

export function FlowNode({ data, selected }: NodeProps<N9nFlowNode>) {
  const Icon = icons[data.kind];
  const isTrigger = data.kind.startsWith("trigger.");
  const isAnnotation = data.kind.startsWith("annotation.");
  const isCondition = data.kind === "logic.condition";

  if (data.kind === "annotation.group") {
    return (
      <div className={`canvas-group canvas-group--${String(data.config.color ?? "purple")}${selected ? " is-selected" : ""}`}>
        <PanelsTopLeft size={14} />
        <strong>{data.label}</strong>
      </div>
    );
  }

  if (data.kind === "annotation.sticky") {
    return (
      <div className={`sticky-note sticky-note--${String(data.config.color ?? "yellow")}${selected ? " is-selected" : ""}`}>
        <span><StickyNote size={14} /> {data.label}</span>
        <p>{String(data.config.text ?? "Double-click to edit this note.")}</p>
      </div>
    );
  }

  return (
    <div
      className={"flow-node flow-node--" + data.kind.replace(".", "-") +
        (selected ? " is-selected" : "")}
    >
      {!isTrigger && !isAnnotation && (
        <Handle
          type="target"
          position={Position.Left}
          className="flow-handle"
        />
      )}

      <div className="flow-node__icon">
        <Icon size={18} strokeWidth={1.8} />
      </div>
      <div className="flow-node__copy">
        <span>{kindNames[data.kind]}</span>
        <strong>{data.label}</strong>
      </div>

      {isCondition ? (
        <>
          <span className="branch-label branch-label--true">yes</span>
          <Handle
            id="true"
            type="source"
            position={Position.Right}
            className="flow-handle flow-handle--true"
            style={{ top: "35%" }}
          />
          <span className="branch-label branch-label--false">no</span>
          <Handle
            id="false"
            type="source"
            position={Position.Right}
            className="flow-handle flow-handle--false"
            style={{ top: "70%" }}
          />
        </>
      ) : !isAnnotation ? (
        <Handle
          type="source"
          position={Position.Right}
          className="flow-handle"
        />
      ) : null}
    </div>
  );
}
