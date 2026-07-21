"use client";
/* eslint-disable react-hooks/set-state-in-effect -- API hydration and flow selection intentionally synchronize local editor state. */

import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  MarkerType,
  ReactFlow,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
  type ReactFlowInstance,
} from "@xyflow/react";
import {
  Activity,
  AlertTriangle,
  Braces,
  Check,
  ChevronRight,
  Clock3,
  Code2,
  Copy,
  GitBranch,
  Globe2,
  History,
  FlaskConical,
  MousePointerClick,
  Play,
  Plus,
  Redo2,
  Save,
  Settings2,
  Undo2,
  Webhook,
  X,
  Zap,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent as ReactDragEvent,
} from "react";
import { FlowNode, type N9nFlowNode } from "./FlowNode";
import type {
  NodeConfig,
  NodeKind,
  NodeTestResult,
  Workflow,
  WorkflowEdge,
  WorkflowNode,
  WorkflowRun,
} from "@/lib/types";
import {
  validateWorkflowGraph,
  wouldCreateCycle,
  type ValidationIssue,
} from "@/lib/workflow-validation";

const nodeTypes = { n9n: FlowNode };

const NODE_WIDTH = 216;
const NODE_HEIGHT = 68;
const NODE_GAP = 40;
const DRAG_MIME = "application/x-9n9-node-kind";
const HISTORY_LIMIT = 100;

type GraphSnapshot = {
  nodes: N9nFlowNode[];
  edges: Edge[];
};

type PositionBounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

function cloneGraph(nodes: N9nFlowNode[], edges: Edge[]): GraphSnapshot {
  return structuredClone({ nodes, edges });
}

function findOpenNodePosition(
  center: { x: number; y: number },
  nodes: N9nFlowNode[],
  bounds?: PositionBounds,
) {
  const origin = {
    x: center.x - NODE_WIDTH / 2,
    y: center.y - NODE_HEIGHT / 2,
  };
  const stepX = NODE_WIDTH + NODE_GAP;
  const stepY = NODE_HEIGHT + NODE_GAP;
  const offsets = [
    [0, 0],
    [0, 1],
    [0, -1],
    [1, 0],
    [-1, 0],
    [1, 1],
    [-1, 1],
    [1, -1],
    [-1, -1],
    [0, 2],
    [0, -2],
    [2, 0],
    [-2, 0],
  ];

  let firstOpen: { x: number; y: number } | null = null;

  for (const [column, row] of offsets) {
    const candidate = {
      x: origin.x + column * stepX,
      y: origin.y + row * stepY,
    };
    const isOpen = nodes.every((node) => {
      const existing = node.position;
      return (
        candidate.x + NODE_WIDTH + NODE_GAP <= existing.x ||
        existing.x + NODE_WIDTH + NODE_GAP <= candidate.x ||
        candidate.y + NODE_HEIGHT + NODE_GAP <= existing.y ||
        existing.y + NODE_HEIGHT + NODE_GAP <= candidate.y
      );
    });
    if (!isOpen) continue;
    firstOpen ??= candidate;
    const isInside =
      !bounds ||
      (candidate.x >= bounds.left &&
        candidate.x <= bounds.right &&
        candidate.y >= bounds.top &&
        candidate.y <= bounds.bottom);
    if (isInside) return candidate;
  }

  const fallback = firstOpen ?? origin;
  return bounds
    ? {
        x: Math.max(bounds.left, Math.min(fallback.x, bounds.right)),
        y: Math.max(bounds.top, Math.min(fallback.y, bounds.bottom)),
      }
    : fallback;
}

function createNodeId(kind: NodeKind) {
  const randomBytes = crypto.getRandomValues(new Uint8Array(4));
  const suffix = Array.from(randomBytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  )
    .join("")
    .slice(0, 7);
  return kind.split(".").at(-1) + "-" + suffix;
}

function changesWorkflowNodes(changes: NodeChange<N9nFlowNode>[]) {
  return changes.some(
    (change) =>
      change.type === "add" ||
      change.type === "remove" ||
      change.type === "replace" ||
      (change.type === "position" && change.position !== undefined),
  );
}

function changesWorkflowEdges(changes: EdgeChange<Edge>[]) {
  return changes.some((change) => change.type !== "select");
}

function serializeNodes(nodes: N9nFlowNode[]): WorkflowNode[] {
  return nodes.map((node) => ({
    id: node.id,
    type: "n9n",
    position: node.position,
    data: node.data,
  }));
}

function serializeEdges(edges: Edge[]): WorkflowEdge[] {
  return edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle,
  }));
}

type ServiceStatus = {
  codex: "online" | "offline";
  version: string;
  telemetry: boolean;
};

const palette: Array<{
  kind: NodeKind;
  title: string;
  group: string;
  icon: typeof Play;
  config: NodeConfig;
}> = [
  {
    kind: "trigger.manual",
    title: "Manual",
    group: "Triggers",
    icon: MousePointerClick,
    config: {},
  },
  {
    kind: "trigger.webhook",
    title: "Webhook",
    group: "Triggers",
    icon: Webhook,
    config: {},
  },
  {
    kind: "trigger.schedule",
    title: "Schedule",
    group: "Triggers",
    icon: Clock3,
    config: { cron: "0 * * * *" },
  },
  {
    kind: "action.codex",
    title: "Local Codex",
    group: "Actions",
    icon: Code2,
    config: { prompt: "Summarize this input:\n\n{{input.body}}" },
  },
  {
    kind: "action.http",
    title: "HTTP",
    group: "Actions",
    icon: Globe2,
    config: {
      method: "GET",
      url: "https://example.com",
      headers: "{}",
      body: "",
    },
  },
  {
    kind: "data.compose",
    title: "Compose",
    group: "Data",
    icon: Braces,
    config: { value: '{\n  "message": "{{input.body}}"\n}' },
  },
  {
    kind: "logic.condition",
    title: "Condition",
    group: "Logic",
    icon: GitBranch,
    config: { left: "{{input.body.status}}", operation: "equals", right: "ok" },
  },
];

const templateFields: Partial<
  Record<NodeKind, Array<{ key: string; label: string }>>
> = {
  "action.codex": [
    { key: "prompt", label: "Prompt" },
    { key: "cwd", label: "Workspace" },
  ],
  "action.http": [
    { key: "url", label: "URL" },
    { key: "headers", label: "Headers" },
    { key: "body", label: "Body" },
  ],
  "data.compose": [{ key: "value", label: "Value" }],
  "logic.condition": [
    { key: "left", label: "Left value" },
    { key: "right", label: "Right value" },
  ],
};

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error ?? "Request failed");
  }
  return body as T;
}

function toFlowNodes(workflow: Workflow): N9nFlowNode[] {
  return workflow.graph.nodes as N9nFlowNode[];
}

function formatTime(value?: string) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function WorkflowStudio() {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [active, setActive] = useState<Workflow | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<N9nFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<"flow" | "runs">("flow");
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [service, setService] = useState<ServiceStatus | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [validationOpen, setValidationOpen] = useState(false);
  const [historyAvailability, setHistoryAvailability] = useState({
    canUndo: false,
    canRedo: false,
  });
  const [testingNodeId, setTestingNodeId] = useState<string | null>(null);
  const [nodeTestInput, setNodeTestInput] = useState("{}");
  const [nodeTestResult, setNodeTestResult] =
    useState<NodeTestResult | null>(null);
  const [notice, setNotice] = useState("Ready");
  const [runResult, setRunResult] = useState<WorkflowRun | null>(null);
  const [flowInstance, setFlowInstance] =
    useState<ReactFlowInstance<N9nFlowNode, Edge> | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const pastRef = useRef<GraphSnapshot[]>([]);
  const futureRef = useRef<GraphSnapshot[]>([]);
  const connectingRef = useRef(false);
  const hydratedWorkflowIdRef = useRef<string | null>(null);

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedId) ?? null,
    [nodes, selectedId],
  );
  const validationIssues = useMemo(
    () => validateWorkflowGraph(serializeNodes(nodes), serializeEdges(edges)),
    [edges, nodes],
  );
  const invalidNodeIds = useMemo(
    () =>
      new Set(
        validationIssues.flatMap((issue) =>
          issue.nodeId ? [issue.nodeId] : [],
        ),
      ),
    [validationIssues],
  );
  const renderNodes = useMemo(
    () =>
      nodes.map((node) => ({
        ...node,
        className: [
          typeof node.className === "string" ? node.className : "",
          invalidNodeIds.has(node.id) ? "has-validation-error" : "",
        ]
          .filter(Boolean)
          .join(" "),
      })),
    [invalidNodeIds, nodes],
  );
  const { canUndo, canRedo } = historyAvailability;

  const load = useCallback(async () => {
    try {
      const [flowList, currentStatus] = await Promise.all([
        jsonRequest<Workflow[]>("/api/workflows"),
        jsonRequest<ServiceStatus>("/api/status"),
      ]);
      setWorkflows(flowList);
      setService(currentStatus);
      setActive((current) => {
        if (current) {
          return flowList.find((item) => item.id === current.id) ?? flowList[0];
        }
        return flowList[0] ?? null;
      });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not load 9n9");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!active) return;
    if (hydratedWorkflowIdRef.current === active.id) return;
    hydratedWorkflowIdRef.current = active.id;
    setNodes(toFlowNodes(active));
    setEdges(active.graph.edges);
    setSelectedId(null);
    setDirty(false);
    setRunResult(null);
    setNodeTestResult(null);
    pastRef.current = [];
    futureRef.current = [];
    setHistoryAvailability({ canUndo: false, canRedo: false });
  }, [active, setEdges, setNodes]);

  const loadRuns = useCallback(async () => {
    try {
      setRuns(await jsonRequest<WorkflowRun[]>("/api/runs"));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not load runs");
    }
  }, []);

  useEffect(() => {
    if (view === "runs") void loadRuns();
  }, [loadRuns, view]);

  const recordHistory = useCallback(() => {
    pastRef.current = [
      ...pastRef.current.slice(-(HISTORY_LIMIT - 1)),
      cloneGraph(nodes, edges),
    ];
    futureRef.current = [];
    setHistoryAvailability({ canUndo: true, canRedo: false });
  }, [edges, nodes]);

  const undo = useCallback(() => {
    const snapshot = pastRef.current.at(-1);
    if (!snapshot) return;
    futureRef.current = [cloneGraph(nodes, edges), ...futureRef.current];
    pastRef.current = pastRef.current.slice(0, -1);
    setNodes(snapshot.nodes);
    setEdges(snapshot.edges);
    setSelectedId(null);
    setDirty(true);
    setNotice("Undid graph change");
    setHistoryAvailability({
      canUndo: pastRef.current.length > 0,
      canRedo: true,
    });
  }, [edges, nodes, setEdges, setNodes]);

  const redo = useCallback(() => {
    const snapshot = futureRef.current[0];
    if (!snapshot) return;
    pastRef.current = [
      ...pastRef.current.slice(-(HISTORY_LIMIT - 1)),
      cloneGraph(nodes, edges),
    ];
    futureRef.current = futureRef.current.slice(1);
    setNodes(snapshot.nodes);
    setEdges(snapshot.edges);
    setSelectedId(null);
    setDirty(true);
    setNotice("Redid graph change");
    setHistoryAvailability({
      canUndo: true,
      canRedo: futureRef.current.length > 0,
    });
  }, [edges, nodes, setEdges, setNodes]);

  useEffect(() => {
    const handleKeyboard = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isEditing =
        target?.matches("input, textarea, select, [contenteditable='true']") ??
        false;
      if (isEditing) return;

      const command = event.metaKey || event.ctrlKey;
      if (command && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (command && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
        return;
      }
      if (event.key !== "Backspace" && event.key !== "Delete") return;

      const selectedNodeIds = new Set(
        nodes
          .filter((node) => node.selected || node.id === selectedId)
          .map((node) => node.id),
      );
      const selectedEdgeIds = new Set(
        edges.filter((edge) => edge.selected).map((edge) => edge.id),
      );
      if (selectedNodeIds.size === 0 && selectedEdgeIds.size === 0) return;

      event.preventDefault();
      recordHistory();
      setNodes((items) =>
        items.filter((node) => !selectedNodeIds.has(node.id)),
      );
      setEdges((items) =>
        items.filter(
          (edge) =>
            !selectedEdgeIds.has(edge.id) &&
            !selectedNodeIds.has(edge.source) &&
            !selectedNodeIds.has(edge.target),
        ),
      );
      setSelectedId(null);
      setDirty(true);
      setNotice("Deleted selection");
    };

    window.addEventListener("keydown", handleKeyboard);
    return () => window.removeEventListener("keydown", handleKeyboard);
  }, [edges, nodes, recordHistory, redo, selectedId, setEdges, setNodes, undo]);

  const persist = useCallback(
    async (enabledOverride?: boolean) => {
      if (!active) return null;
      setSaving(true);
      setNotice("Saving…");
      try {
        const saved = await jsonRequest<Workflow>(
          "/api/workflows/" + active.id,
          {
            method: "PUT",
            body: JSON.stringify({
              name: active.name,
              enabled: enabledOverride ?? active.enabled,
              graph: {
                nodes: serializeNodes(nodes),
                edges: serializeEdges(edges),
              },
            }),
          },
        );
        setActive(saved);
        setWorkflows((items) =>
          items.map((item) => (item.id === saved.id ? saved : item)),
        );
        setDirty(false);
        setNotice("Saved");
        return saved;
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "Save failed");
        return null;
      } finally {
        setSaving(false);
      }
    },
    [active, edges, nodes],
  );

  const createFlow = async () => {
    try {
      const created = await jsonRequest<Workflow>("/api/workflows", {
        method: "POST",
        body: JSON.stringify({ name: "Untitled flow" }),
      });
      setWorkflows((items) => [created, ...items]);
      setActive(created);
      setView("flow");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not create flow");
    }
  };

  const runFlow = async () => {
    if (!active) return;
    if (validationIssues.length > 0) {
      setValidationOpen(true);
      setNotice(
        validationIssues.length === 1
          ? "Fix 1 validation issue before running"
          : "Fix " + validationIssues.length + " validation issues before running",
      );
      return;
    }
    const saved = await persist();
    if (!saved) return;

    setRunning(true);
    setRunResult(null);
    setNotice("Running…");
    try {
      const response = await fetch("/api/workflows/" + saved.id + "/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: {} }),
      });
      const result = (await response.json()) as WorkflowRun;
      setRunResult(result);
      setNotice(result.status === "success" ? "Run complete" : "Run failed");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Run failed");
    } finally {
      setRunning(false);
    }
  };

  const testSelectedNode = async () => {
    if (!active || !selectedNode) return;
    let input: unknown;
    try {
      input = JSON.parse(nodeTestInput);
    } catch {
      setNodeTestResult({
        nodeId: selectedNode.id,
        label: selectedNode.data.label,
        kind: selectedNode.data.kind,
        status: "failed",
        input: nodeTestInput,
        error: "Test input must be valid JSON",
        durationMs: 0,
      });
      return;
    }

    const saved = await persist();
    if (!saved) return;
    setTestingNodeId(selectedNode.id);
    setNodeTestResult(null);
    setNotice("Testing " + selectedNode.data.label + "…");
    try {
      const response = await fetch(
        "/api/workflows/" + saved.id + "/nodes/" + selectedNode.id + "/test",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ input, steps: {} }),
        },
      );
      const result = (await response.json()) as NodeTestResult;
      setNodeTestResult(result);
      setNotice(result.status === "success" ? "Node test passed" : "Node test failed");
    } catch (error) {
      setNodeTestResult({
        nodeId: selectedNode.id,
        label: selectedNode.data.label,
        kind: selectedNode.data.kind,
        status: "failed",
        input,
        error: error instanceof Error ? error.message : "Node test failed",
        durationMs: 0,
      });
      setNotice("Node test failed");
    } finally {
      setTestingNodeId(null);
    }
  };

  const toggleEnabled = async () => {
    if (!active) return;
    await persist(!active.enabled);
  };

  const addNode = (
    item: (typeof palette)[number],
    requestedCenter?: { x: number; y: number },
  ) => {
    recordHistory();
    const id = createNodeId(item.kind);
    const bounds = canvasRef.current?.getBoundingClientRect();
    const center =
      requestedCenter ??
      (flowInstance && bounds
        ? flowInstance.screenToFlowPosition({
            x: bounds.left + bounds.width / 2,
            y: bounds.top + bounds.height / 2,
          })
        : { x: 400, y: 200 });
    const positionBounds =
      flowInstance && bounds
        ? (() => {
            const topLeft = flowInstance.screenToFlowPosition({
              x: bounds.left + 18,
              y: bounds.top + 18,
            });
            const bottomRight = flowInstance.screenToFlowPosition({
              x: bounds.right - 18,
              y: bounds.bottom - 18,
            });
            return {
              left: topLeft.x,
              top: topLeft.y,
              right: bottomRight.x - NODE_WIDTH,
              bottom: bottomRight.y - NODE_HEIGHT,
            };
          })()
        : undefined;
    const position = findOpenNodePosition(center, nodes, positionBounds);

    const node: N9nFlowNode = {
      id,
      type: "n9n",
      position,
      data: {
        kind: item.kind,
        label: item.title,
        config: { ...item.config },
      },
    };
    setNodes((items) => [
      ...items.map((existing) => ({ ...existing, selected: false })),
      { ...node, selected: true },
    ]);
    setSelectedId(id);
    setDirty(true);
    setNotice("Added " + item.title);

    if (requestedCenter) return;
    requestAnimationFrame(() => {
      flowInstance?.setCenter(
        position.x + NODE_WIDTH / 2,
        position.y + NODE_HEIGHT / 2,
        {
          zoom: Math.min(flowInstance.getZoom(), 1.1),
          duration: 250,
        },
      );
    });
  };

  const handleCanvasDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    const bounds = canvasRef.current?.getBoundingClientRect();
    if (!flowInstance || !bounds) return;
    const kind = event.dataTransfer.getData(DRAG_MIME) as NodeKind;
    const item = palette.find((candidate) => candidate.kind === kind);
    if (!item) return;
    const zoom = flowInstance.getZoom();
    const horizontalMargin = (NODE_WIDTH * zoom) / 2 + 20;
    const verticalMargin = (NODE_HEIGHT * zoom) / 2 + 20;
    const clientX = Math.max(
      bounds.left + horizontalMargin,
      Math.min(event.clientX, bounds.right - horizontalMargin),
    );
    const clientY = Math.max(
      bounds.top + verticalMargin,
      Math.min(event.clientY, bounds.bottom - verticalMargin),
    );
    addNode(
      item,
      flowInstance.screenToFlowPosition({
        x: clientX,
        y: clientY,
      }),
    );
  };

  const connectionAllowed = useCallback(
    (connection: Connection | Edge) => {
      const { source, target } = connection;
      if (!source || !target || source === target) return false;
      const targetNode = nodes.find((node) => node.id === target);
      if (!targetNode || targetNode.data.kind.startsWith("trigger.")) {
        return false;
      }
      if (
        edges.some(
          (edge) =>
            edge.source === source &&
            edge.target === target &&
            edge.sourceHandle === connection.sourceHandle,
        ) ||
        edges.some((edge) => edge.target === target)
      ) {
        return false;
      }
      return !wouldCreateCycle(source, target, edges);
    },
    [edges, nodes],
  );

  const connect = useCallback(
    (connection: Connection) => {
      connectingRef.current = false;
      if (!connectionAllowed(connection)) {
        setNotice("That connection is not allowed");
        return;
      }
      recordHistory();
      const edgeId = [
        connection.source,
        connection.sourceHandle ?? "output",
        connection.target,
      ].join("-");
      setEdges((items) =>
        addEdge(
          {
            ...connection,
            id: edgeId,
            type: "smoothstep",
            markerEnd: { type: MarkerType.ArrowClosed },
          },
          items,
        ),
      );
      setDirty(true);
      setNotice("Connected nodes");
    },
    [connectionAllowed, recordHistory, setEdges],
  );

  const handleNodesChange = useCallback(
    (changes: NodeChange<N9nFlowNode>[]) => {
      onNodesChange(changes);
      if (changesWorkflowNodes(changes)) setDirty(true);
    },
    [onNodesChange],
  );

  const handleEdgesChange = useCallback(
    (changes: EdgeChange<Edge>[]) => {
      onEdgesChange(changes);
      if (changesWorkflowEdges(changes)) setDirty(true);
    },
    [onEdgesChange],
  );

  const updateNode = (patch: Partial<N9nFlowNode["data"]>) => {
    if (!selectedId) return;
    recordHistory();
    setNodes((items) =>
      items.map((node) =>
        node.id === selectedId
          ? { ...node, data: { ...node.data, ...patch } }
          : node,
      ),
    );
    setNodeTestResult(null);
    setDirty(true);
  };

  const updateConfig = (key: string, value: unknown) => {
    if (!selectedNode) return;
    updateNode({
      config: { ...selectedNode.data.config, [key]: value },
    });
  };

  const removeSelected = () => {
    if (!selectedId) return;
    recordHistory();
    setNodes((items) => items.filter((node) => node.id !== selectedId));
    setEdges((items) =>
      items.filter(
        (edge) => edge.source !== selectedId && edge.target !== selectedId,
      ),
    );
    setSelectedId(null);
    setNodeTestResult(null);
    setDirty(true);
    setNotice("Removed node");
  };

  const selectValidationIssue = (issue: ValidationIssue) => {
    if (!issue.nodeId) return;
    const node = nodes.find((item) => item.id === issue.nodeId);
    if (!node) return;
    setSelectedId(node.id);
    setNodes((items) =>
      items.map((item) => ({ ...item, selected: item.id === node.id })),
    );
    flowInstance?.setCenter(
      node.position.x + NODE_WIDTH / 2,
      node.position.y + NODE_HEIGHT / 2,
      { zoom: Math.min(flowInstance.getZoom(), 1.1), duration: 200 },
    );
    setValidationOpen(false);
  };

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand__mark">9</div>
          <div>
            <strong>9n9</strong>
            <span>local automation</span>
          </div>
        </div>

        <nav className="main-nav" aria-label="Main navigation">
          <button
            className={view === "flow" ? "is-active" : ""}
            onClick={() => setView("flow")}
          >
            <Zap size={17} /> Flows
          </button>
          <button
            className={view === "runs" ? "is-active" : ""}
            onClick={() => setView("runs")}
          >
            <History size={17} /> Runs
          </button>
        </nav>

        <div className="sidebar__section-title">
          <span>Your flows</span>
          <button onClick={createFlow} aria-label="Create flow">
            <Plus size={15} />
          </button>
        </div>

        <div className="flow-list">
          {workflows.map((workflow) => (
            <button
              key={workflow.id}
              className={active?.id === workflow.id ? "is-active" : ""}
              onClick={() => {
                setActive(workflow);
                setView("flow");
              }}
            >
              <span
                className={
                  "flow-list__dot " +
                  (workflow.enabled ? "is-enabled" : "")
                }
              />
              <span>{workflow.name}</span>
              <ChevronRight size={14} />
            </button>
          ))}
        </div>

        <div className="sidebar__footer">
          <div>
            <span
              className={
                "status-dot " +
                (service?.codex === "online" ? "is-online" : "")
              }
            />
            Local Codex
          </div>
          <strong>{service?.codex ?? "checking"}</strong>
        </div>
      </aside>

      <section className="workspace">
        {view === "runs" ? (
          <RunsView runs={runs} onRefresh={loadRuns} />
        ) : active ? (
          <>
            <header className="workspace__header">
              <div className="flow-title">
                <input
                  value={active.name}
                  aria-label="Flow name"
                  onChange={(event) => {
                    setActive({ ...active, name: event.target.value });
                    setDirty(true);
                  }}
                />
                <span>
                  /hooks/{active.slug}
                  <button
                    aria-label="Copy webhook path"
                    onClick={() =>
                      navigator.clipboard.writeText(
                        window.location.origin + "/hooks/" + active.slug,
                      )
                    }
                  >
                    <Copy size={12} />
                  </button>
                </span>
              </div>

              <div className="header-actions">
                <button
                  className="icon-button"
                  onClick={undo}
                  disabled={!canUndo}
                  aria-label="Undo"
                  title="Undo (Ctrl/Cmd+Z)"
                >
                  <Undo2 size={15} />
                </button>
                <button
                  className="icon-button"
                  onClick={redo}
                  disabled={!canRedo}
                  aria-label="Redo"
                  title="Redo (Ctrl/Cmd+Shift+Z)"
                >
                  <Redo2 size={15} />
                </button>
                <button
                  className={
                    "validation-button " +
                    (validationIssues.length > 0 ? "has-issues" : "is-valid")
                  }
                  onClick={() => setValidationOpen((open) => !open)}
                  aria-label="Workflow validation"
                >
                  {validationIssues.length > 0 ? (
                    <AlertTriangle size={14} />
                  ) : (
                    <Check size={14} />
                  )}
                  {validationIssues.length > 0
                    ? validationIssues.length + " issues"
                    : "Valid"}
                </button>
                <span className="save-state">
                  {dirty ? "Unsaved" : notice}
                </span>
                <button
                  className={
                    "toggle " + (active.enabled ? "is-enabled" : "")
                  }
                  onClick={toggleEnabled}
                  aria-label={active.enabled ? "Disable flow" : "Enable flow"}
                >
                  <span />
                  {active.enabled ? "Live" : "Off"}
                </button>
                <button
                  className="button button--quiet"
                  onClick={() => void persist()}
                  disabled={saving}
                >
                  <Save size={15} />
                  Save
                </button>
                <button
                  className="button button--run"
                  onClick={runFlow}
                  disabled={running}
                >
                  {running ? (
                    <Activity className="spin" size={15} />
                  ) : (
                    <Play size={15} fill="currentColor" />
                  )}
                  {running ? "Running" : "Run"}
                </button>
              </div>
            </header>

            <div className="studio">
              <NodePalette onAdd={addNode} />

              <div
                className={"canvas " + (dragActive ? "is-drag-target" : "")}
                ref={canvasRef}
                onDragEnter={(event) => {
                  event.preventDefault();
                  setDragActive(true);
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "copy";
                }}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                    setDragActive(false);
                  }
                }}
                onDrop={handleCanvasDrop}
              >
                <ReactFlow
                  nodes={renderNodes}
                  edges={edges}
                  nodeTypes={nodeTypes}
                  onNodesChange={handleNodesChange}
                  onEdgesChange={handleEdgesChange}
                  onConnect={connect}
                  isValidConnection={connectionAllowed}
                  onConnectStart={() => {
                    connectingRef.current = true;
                    setNotice("Choose a node input");
                  }}
                  onConnectEnd={() => {
                    if (connectingRef.current) setNotice("Connection cancelled");
                    connectingRef.current = false;
                  }}
                  onInit={setFlowInstance}
                  onNodeDragStart={recordHistory}
                  onNodeClick={(_, node) => {
                    setSelectedId(node.id);
                    if (nodeTestResult?.nodeId !== node.id) {
                      setNodeTestResult(null);
                    }
                  }}
                  onEdgeClick={() => setSelectedId(null)}
                  onPaneClick={() => {
                    setSelectedId(null);
                    setValidationOpen(false);
                  }}
                  fitView
                  minZoom={0.35}
                  maxZoom={1.7}
                  connectionMode={ConnectionMode.Strict}
                  connectionRadius={28}
                  defaultEdgeOptions={{
                    type: "smoothstep",
                    markerEnd: { type: MarkerType.ArrowClosed },
                  }}
                  proOptions={{ hideAttribution: true }}
                  deleteKeyCode={null}
                >
                  <Background
                    variant={BackgroundVariant.Dots}
                    gap={22}
                    size={1}
                    color="#30333a"
                  />
                  <Controls showInteractive={false} />
                </ReactFlow>

                {validationOpen && (
                  <ValidationPanel
                    issues={validationIssues}
                    onSelect={selectValidationIssue}
                    onClose={() => setValidationOpen(false)}
                  />
                )}

                {runResult && (
                  <RunPanel
                    run={runResult}
                    onClose={() => setRunResult(null)}
                  />
                )}
              </div>

              <Inspector
                node={selectedNode}
                workflow={active}
                nodes={nodes}
                edges={edges}
                onLabel={(value) => updateNode({ label: value })}
                onConfig={updateConfig}
                onRemove={removeSelected}
                testInput={nodeTestInput}
                onTestInput={setNodeTestInput}
                testResult={nodeTestResult}
                testing={testingNodeId === selectedNode?.id}
                onTest={() => void testSelectedNode()}
              />
            </div>
          </>
        ) : (
          <div className="empty-state">
            <Zap size={28} />
            <h1>Build the first flow</h1>
            <button className="button button--run" onClick={createFlow}>
              <Plus size={15} /> New flow
            </button>
          </div>
        )}
      </section>
    </main>
  );
}

function NodePalette({
  onAdd,
}: {
  onAdd: (item: (typeof palette)[number]) => void;
}) {
  const groups = ["Triggers", "Actions", "Data", "Logic"];
  return (
    <aside className="palette">
      <div className="panel-title">
        <span>Nodes</span>
        <small>drag or click</small>
      </div>
      {groups.map((group) => (
        <div className="palette__group" key={group}>
          <span>{group}</span>
          {palette
            .filter((item) => item.group === group)
            .map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.kind}
                  draggable
                  data-node-kind={item.kind}
                  onClick={() => onAdd(item)}
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = "copy";
                    event.dataTransfer.setData(DRAG_MIME, item.kind);
                    event.dataTransfer.setData("text/plain", item.kind);
                  }}
                >
                  <Icon size={16} />
                  {item.title}
                  <Plus size={13} />
                </button>
              );
            })}
        </div>
      ))}
      <div className="template-tip">
        <Braces size={14} />
        Use <code>{"{{input.body}}"}</code> or{" "}
        <code>{"{{steps.nodeId.body}}"}</code>
      </div>
    </aside>
  );
}

function ValidationPanel({
  issues,
  onSelect,
  onClose,
}: {
  issues: ValidationIssue[];
  onSelect: (issue: ValidationIssue) => void;
  onClose: () => void;
}) {
  return (
    <section className="validation-panel" aria-label="Validation issues">
      <header>
        <div>
          <AlertTriangle size={15} />
          <strong>Workflow validation</strong>
        </div>
        <button onClick={onClose} aria-label="Close validation">
          <X size={15} />
        </button>
      </header>
      {issues.length === 0 ? (
        <div className="validation-panel__valid">
          <Check size={16} /> Ready to run
        </div>
      ) : (
        <div className="validation-panel__list">
          {issues.map((issue) => (
            <button
              key={issue.id}
              onClick={() => onSelect(issue)}
              disabled={!issue.nodeId}
            >
              <AlertTriangle size={13} />
              <span>{issue.message}</span>
              {issue.nodeId && <ChevronRight size={13} />}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function Inspector({
  node,
  workflow,
  nodes,
  edges,
  onLabel,
  onConfig,
  onRemove,
  testInput,
  onTestInput,
  testResult,
  testing,
  onTest,
}: {
  node: N9nFlowNode | null;
  workflow: Workflow;
  nodes: N9nFlowNode[];
  edges: Edge[];
  onLabel: (value: string) => void;
  onConfig: (key: string, value: unknown) => void;
  onRemove: () => void;
  testInput: string;
  onTestInput: (value: string) => void;
  testResult: NodeTestResult | null;
  testing: boolean;
  onTest: () => void;
}) {
  const availableFields = node ? (templateFields[node.data.kind] ?? []) : [];
  const [expressionTarget, setExpressionTarget] = useState("");
  const activeExpressionTarget = availableFields.some(
    (field) => field.key === expressionTarget,
  )
    ? expressionTarget
    : (availableFields[0]?.key ?? "");

  if (!node) {
    return (
      <aside className="inspector inspector--empty">
        <Settings2 size={20} />
        <strong>Select a node</strong>
        <p>Its settings will stay here, out of your way.</p>
      </aside>
    );
  }

  const config = node.data.config;
  const text = (key: string) => String(config[key] ?? "");
  const input = (key: string) => (event: ChangeEvent<HTMLInputElement>) =>
    onConfig(key, event.target.value);
  const textarea = (key: string) => (
    event: ChangeEvent<HTMLTextAreaElement>,
  ) => onConfig(key, event.target.value);
  const upstreamIds = new Set<string>();
  const queue = [node.id];
  while (queue.length) {
    const current = queue.shift()!;
    for (const edge of edges.filter((item) => item.target === current)) {
      if (upstreamIds.has(edge.source)) continue;
      upstreamIds.add(edge.source);
      queue.push(edge.source);
    }
  }
  const expressions = [
    { label: "Input body", value: "{{input.body}}" },
    ...nodes
      .filter((item) => upstreamIds.has(item.id))
      .flatMap((item) => [
        {
          label: item.data.label + " output",
          value: "{{steps." + item.id + "}}",
        },
        ...(item.data.kind === "action.http"
          ? [
              {
                label: item.data.label + " body",
                value: "{{steps." + item.id + ".body}}",
              },
            ]
          : []),
      ]),
  ];
  const insertExpression = (expression: string) => {
    if (!activeExpressionTarget) return;
    const current = text(activeExpressionTarget);
    const separator = current && !/\s$/.test(current) ? " " : "";
    onConfig(activeExpressionTarget, current + separator + expression);
  };

  return (
    <aside className="inspector">
      <div className="panel-title">
        <span>Configure</span>
        <small>{node.data.kind}</small>
      </div>

      <Field label="Name">
        <input
          value={node.data.label}
          onChange={(event) => onLabel(event.target.value)}
        />
      </Field>

      {node.data.kind === "action.codex" && (
        <>
          <Field
            label="Prompt"
            hint="Runs through your authenticated local Codex container."
          >
            <textarea
              rows={10}
              value={text("prompt")}
              onChange={textarea("prompt")}
              onFocus={() => setExpressionTarget("prompt")}
            />
          </Field>
          <Field label="Workspace">
            <input
              value={text("cwd") || "/workspace"}
              onChange={input("cwd")}
              onFocus={() => setExpressionTarget("cwd")}
            />
          </Field>
        </>
      )}

      {node.data.kind === "action.http" && (
        <>
          <Field label="Method">
            <select value={text("method") || "GET"} onChange={(event) => onConfig("method", event.target.value)}>
              {["GET", "POST", "PUT", "PATCH", "DELETE"].map((method) => (
                <option key={method}>{method}</option>
              ))}
            </select>
          </Field>
          <Field label="URL">
            <input
              value={text("url")}
              onChange={input("url")}
              onFocus={() => setExpressionTarget("url")}
            />
          </Field>
          <Field label="Headers" hint="JSON object">
            <textarea
              rows={4}
              value={text("headers")}
              onChange={textarea("headers")}
              onFocus={() => setExpressionTarget("headers")}
            />
          </Field>
          <Field label="Body">
            <textarea
              rows={7}
              value={text("body")}
              onChange={textarea("body")}
              onFocus={() => setExpressionTarget("body")}
            />
          </Field>
        </>
      )}

      {node.data.kind === "data.compose" && (
        <Field label="Value" hint="Plain text or JSON; templates are resolved first.">
          <textarea
            rows={12}
            value={text("value")}
            onChange={textarea("value")}
            onFocus={() => setExpressionTarget("value")}
          />
        </Field>
      )}

      {node.data.kind === "logic.condition" && (
        <>
          <Field label="Left value">
            <input
              value={text("left")}
              onChange={input("left")}
              onFocus={() => setExpressionTarget("left")}
            />
          </Field>
          <Field label="Operation">
            <select
              value={text("operation") || "equals"}
              onChange={(event) => onConfig("operation", event.target.value)}
            >
              <option value="equals">equals</option>
              <option value="not_equals">does not equal</option>
              <option value="contains">contains</option>
              <option value="truthy">is truthy</option>
            </select>
          </Field>
          <Field label="Right value">
            <input
              value={text("right")}
              onChange={input("right")}
              onFocus={() => setExpressionTarget("right")}
            />
          </Field>
        </>
      )}

      {node.data.kind === "trigger.schedule" && (
        <Field label="Cron" hint="Example: 0 * * * * runs every hour.">
          <input value={text("cron")} onChange={input("cron")} />
        </Field>
      )}

      {node.data.kind === "trigger.webhook" && (
        <div className="info-card">
          <Webhook size={16} />
          <div>
            <span>Webhook path</span>
            <code>/hooks/{workflow.slug}</code>
            <small>Enable the flow before calling it.</small>
          </div>
        </div>
      )}

      {node.data.kind === "trigger.manual" && (
        <div className="info-card">
          <MousePointerClick size={16} />
          <div>
            <span>Manual trigger</span>
            <small>Starts when you press Run.</small>
          </div>
        </div>
      )}

      {availableFields.length > 0 && (
        <section className="expression-picker">
          <header>
            <Braces size={14} />
            <strong>Insert expression</strong>
          </header>
          <select
            aria-label="Expression target"
            value={activeExpressionTarget}
            onChange={(event) => setExpressionTarget(event.target.value)}
          >
            {availableFields.map((field) => (
              <option key={field.key} value={field.key}>
                {field.label}
              </option>
            ))}
          </select>
          <div>
            {expressions.map((expression) => (
              <button
                key={expression.label + expression.value}
                onClick={() => insertExpression(expression.value)}
                title={expression.value}
              >
                <Plus size={11} /> {expression.label}
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="node-test">
        <header>
          <div>
            <FlaskConical size={14} />
            <strong>Test this node</strong>
          </div>
          <button
            className="button button--quiet"
            onClick={onTest}
            disabled={testing}
          >
            {testing ? <Activity className="spin" size={13} /> : <Play size={13} />}
            {testing ? "Testing" : "Test node"}
          </button>
        </header>
        <label>
          <span>Input JSON</span>
          <textarea
            aria-label="Test input JSON"
            rows={5}
            value={testInput}
            onChange={(event) => onTestInput(event.target.value)}
          />
        </label>
        {testResult?.nodeId === node.id && (
          <div className={"node-test__result node-test__result--" + testResult.status}>
            <span>
              {testResult.status} · {testResult.durationMs}ms
            </span>
            <pre>
              {JSON.stringify(
                testResult.error
                  ? { error: testResult.error }
                  : testResult.output,
                null,
                2,
              )}
            </pre>
          </div>
        )}
      </section>

      <button className="danger-link" onClick={onRemove}>
        Remove node
      </button>
    </aside>
  );
}

function RunPanel({
  run,
  onClose,
}: {
  run: WorkflowRun;
  onClose: () => void;
}) {
  return (
    <section className="run-panel">
      <header>
        <div>
          <span className={"run-badge run-badge--" + run.status}>
            {run.status === "success" ? <Check size={12} /> : <X size={12} />}
            {run.status}
          </span>
          <strong>{run.trace.length} nodes executed</strong>
        </div>
        <button onClick={onClose} aria-label="Close run result">
          <X size={16} />
        </button>
      </header>
      <div className="run-panel__body">
        <div className="trace">
          {run.trace.map((item, index) => (
            <div className="trace__item" key={item.nodeId}>
              <span>{index + 1}</span>
              <div>
                <strong>{item.label}</strong>
                <small>
                  {item.kind} · {item.durationMs}ms
                </small>
              </div>
              <span className={"trace__status trace__status--" + item.status}>
                {item.status}
              </span>
            </div>
          ))}
        </div>
        <pre>{JSON.stringify(run.error ? { error: run.error } : run.output, null, 2)}</pre>
      </div>
    </section>
  );
}

function RunsView({
  runs,
  onRefresh,
}: {
  runs: WorkflowRun[];
  onRefresh: () => void;
}) {
  const [selected, setSelected] = useState<WorkflowRun | null>(null);
  return (
    <div className="runs-view">
      <header className="runs-header">
        <div>
          <span>Execution history</span>
          <h1>Runs</h1>
        </div>
        <button className="button button--quiet" onClick={onRefresh}>
          <Activity size={15} /> Refresh
        </button>
      </header>

      <div className="runs-table">
        <div className="runs-table__head">
          <span>Status</span>
          <span>Flow</span>
          <span>Trigger</span>
          <span>Started</span>
          <span>Duration</span>
        </div>
        {runs.map((run) => (
          <button
            className="runs-table__row"
            key={run.id}
            onClick={() => setSelected(run)}
          >
            <span>
              <i className={"run-dot run-dot--" + run.status} />
              {run.status}
            </span>
            <strong>{run.workflowName}</strong>
            <span>{run.triggerType}</span>
            <span>{formatTime(run.startedAt)}</span>
            <span>
              {run.finishedAt
                ? new Date(run.finishedAt).getTime() -
                  new Date(run.startedAt).getTime() +
                  "ms"
                : "running"}
            </span>
          </button>
        ))}
        {!runs.length && (
          <div className="runs-empty">No noise yet. Run a flow when you’re ready.</div>
        )}
      </div>

      {selected && (
        <div className="run-detail">
          <button onClick={() => setSelected(null)} aria-label="Close details">
            <X size={16} />
          </button>
          <span className={"run-badge run-badge--" + selected.status}>
            {selected.status}
          </span>
          <h2>{selected.workflowName}</h2>
          <p>{formatTime(selected.startedAt)}</p>
          <pre>{JSON.stringify(selected, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}
