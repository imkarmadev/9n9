"use client";

import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  type EdgeProps,
} from "@xyflow/react";
import { createContext, useContext, type ReactNode } from "react";
import { X } from "lucide-react";

type EdgeActions = {
  updateLabel: (id: string, label: string) => void;
  remove: (id: string) => void;
};

const EdgeActionsContext = createContext<EdgeActions | null>(null);

export function WorkflowEdgeActionsProvider({
  actions,
  children,
}: {
  actions: EdgeActions;
  children: ReactNode;
}) {
  return (
    <EdgeActionsContext.Provider value={actions}>
      {children}
    </EdgeActionsContext.Provider>
  );
}

export function WorkflowEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  selected,
  label,
}: EdgeProps) {
  const actions = useContext(EdgeActionsContext);
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  const text = typeof label === "string" ? label : "";

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} />
      {(selected || text) && (
        <EdgeLabelRenderer>
          <div
            className={"edge-editor nodrag nopan" + (selected ? " is-selected" : "")}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {selected ? (
              <>
                <input
                  aria-label="Edge label"
                  placeholder="Add label"
                  value={text}
                  onChange={(event) => actions?.updateLabel(id, event.target.value)}
                />
                <button aria-label="Delete edge" onClick={() => actions?.remove(id)}>
                  <X size={12} />
                </button>
              </>
            ) : (
              <span>{text}</span>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
