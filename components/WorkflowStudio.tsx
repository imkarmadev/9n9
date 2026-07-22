"use client";
/* eslint-disable react-hooks/set-state-in-effect -- API/local-storage hydration and flow selection intentionally synchronize editor state. */

import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  SelectionMode,
  addEdge,
  reconnectEdge,
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
  Archive,
  Braces,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Code2,
  Copy,
  Download,
  GitBranch,
  Globe2,
  History,
  KeyRound,
  Keyboard,
  LayoutDashboard,
  LayoutTemplate,
  LogOut,
  FlaskConical,
  MousePointerClick,
  PanelLeftClose,
  PanelRightClose,
  PanelsTopLeft,
  Play,
  Plus,
  Redo2,
  Save,
  Search,
  Settings2,
  StickyNote,
  ShieldCheck,
  UserRound,
  Upload,
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
import { WorkflowEdge as EditableWorkflowEdge, WorkflowEdgeActionsProvider } from "./WorkflowEdge";
import { AccountView, AuditView, CredentialsView } from "./SecurityViews";
import type { CredentialSummary } from "@/lib/credentials";
import type {
  NodeConfig,
  NodeKind,
  NodeTestResult,
  SampleMode,
  Workflow,
  WorkflowEdge,
  WorkflowNode,
  WorkflowRun,
  WorkflowTemplate,
  WorkflowVersion,
} from "@/lib/types";
import {
  expressionPaths,
  previewTemplate,
  type TemplateContext,
} from "@/lib/template";
import {
  validateWorkflowGraph,
  wouldCreateCycle,
  type ValidationIssue,
} from "@/lib/workflow-validation";

const nodeTypes = { n9n: FlowNode };
const edgeTypes = { workflow: EditableWorkflowEdge };

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

type CanvasMenu = {
  x: number;
  y: number;
  kind: "pane" | "node" | "edge";
  id?: string;
  flowPosition?: { x: number; y: number };
};

type NodeDefaults = Partial<Record<NodeKind, NodeConfig>>;

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
    ...(typeof edge.label === "string" && edge.label.trim()
      ? { label: edge.label.trim() }
      : {}),
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
  {
    kind: "annotation.group",
    title: "Canvas group",
    group: "Canvas",
    icon: PanelsTopLeft,
    config: { width: 380, height: 220, color: "purple" },
  },
  {
    kind: "annotation.sticky",
    title: "Sticky note",
    group: "Canvas",
    icon: StickyNote,
    config: { text: "Describe this part of the workflow.", color: "yellow" },
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

async function jsonRequest<T>(url: string, csrfToken: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(!["GET", "HEAD", "OPTIONS"].includes(method)
        ? { "x-9n9-csrf": csrfToken }
        : {}),
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

export function WorkflowStudio({ csrfToken, username }: { csrfToken: string; username: string }) {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [active, setActive] = useState<Workflow | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<N9nFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [view, setView] = useState<"flow" | "runs" | "templates" | "credentials" | "audit" | "account">("flow");
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [versions, setVersions] = useState<WorkflowVersion[]>([]);
  const [credentials, setCredentials] = useState<CredentialSummary[]>([]);
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
  const [saveError, setSaveError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [paletteCollapsed, setPaletteCollapsed] = useState(false);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [nodeSearch, setNodeSearch] = useState("");
  const [recentKinds, setRecentKinds] = useState<NodeKind[]>([]);
  const [nodeDefaults, setNodeDefaults] = useState<NodeDefaults>({});
  const [canvasMenu, setCanvasMenu] = useState<CanvasMenu | null>(null);
  const [flowSearch, setFlowSearch] = useState("");
  const [flowFilter, setFlowFilter] = useState<"active" | "archived" | "all">("active");
  const [flowSort, setFlowSort] = useState<"updated" | "created" | "name">("updated");
  const [runResult, setRunResult] = useState<WorkflowRun | null>(null);
  const [flowInstance, setFlowInstance] =
    useState<ReactFlowInstance<N9nFlowNode, Edge> | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const pastRef = useRef<GraphSnapshot[]>([]);
  const futureRef = useRef<GraphSnapshot[]>([]);
  const connectingRef = useRef(false);
  const hydratedWorkflowIdRef = useRef<string | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const editRevisionRef = useRef(0);
  const failedRevisionRef = useRef(-1);
  const savingRef = useRef(false);
  const clipboardRef = useRef<GraphSnapshot | null>(null);

  const markDirty = useCallback(() => {
    editRevisionRef.current += 1;
    setDirty(true);
    setSaveError("");
  }, []);

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedId) ?? null,
    [nodes, selectedId],
  );
  const selectedNodeIds = useMemo(
    () =>
      new Set(
        nodes
          .filter((node) => node.selected || node.id === selectedId)
          .map((node) => node.id),
      ),
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
        style: node.data.kind === "annotation.group"
          ? {
              width: Number(node.data.config.width ?? 380),
              height: Number(node.data.config.height ?? 220),
              zIndex: -1,
            }
          : node.data.kind === "annotation.sticky"
            ? { width: 190, minHeight: 130, zIndex: 0 }
            : node.style,
        className: [
          typeof node.className === "string" ? node.className : "",
          invalidNodeIds.has(node.id) ? "has-validation-error" : "",
        ]
          .filter(Boolean)
          .join(" "),
      })),
    [invalidNodeIds, nodes],
  );
  const renderEdges = useMemo(
    () =>
      edges.map((edge) => ({
        ...edge,
        type: "workflow",
        markerEnd: edge.markerEnd ?? { type: MarkerType.ArrowClosed },
      })),
    [edges],
  );
  const { canUndo, canRedo } = historyAvailability;
  const visibleWorkflows = useMemo(() => {
    const query = flowSearch.trim().toLowerCase();
    return workflows
      .filter((workflow) => flowFilter === "all" || (flowFilter === "archived" ? Boolean(workflow.archivedAt) : !workflow.archivedAt))
      .filter((workflow) => !query || workflow.name.toLowerCase().includes(query) || workflow.description.toLowerCase().includes(query) || workflow.tags.some((tag) => tag.includes(query)))
      .sort((left, right) => flowSort === "name" ? left.name.localeCompare(right.name) : new Date(flowSort === "created" ? right.createdAt : right.updatedAt).getTime() - new Date(flowSort === "created" ? left.createdAt : left.updatedAt).getTime());
  }, [flowFilter, flowSearch, flowSort, workflows]);

  useEffect(() => {
    try {
      setRecentKinds(JSON.parse(localStorage.getItem("9n9.recent-nodes") ?? "[]") as NodeKind[]);
      setNodeDefaults(JSON.parse(localStorage.getItem("9n9.node-defaults") ?? "{}") as NodeDefaults);
    } catch {
      setRecentKinds([]);
      setNodeDefaults({});
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const [flowList, currentStatus, credentialList, templateList, runList] = await Promise.all([
        jsonRequest<Workflow[]>("/api/workflows?archived=all", csrfToken),
        jsonRequest<ServiceStatus>("/api/status", csrfToken),
        jsonRequest<CredentialSummary[]>("/api/credentials", csrfToken),
        jsonRequest<WorkflowTemplate[]>("/api/templates", csrfToken),
        jsonRequest<WorkflowRun[]>("/api/runs", csrfToken),
      ]);
      setWorkflows(flowList);
      setService(currentStatus);
      setCredentials(credentialList);
      setTemplates(templateList);
      setRuns(runList);
      setActive((current) => {
        if (current) {
          return flowList.find((item) => item.id === current.id) ?? flowList[0];
        }
        return flowList.find((item) => !item.archivedAt) ?? flowList[0] ?? null;
      });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not load 9n9");
    }
  }, [csrfToken]);

  const loadCredentials = useCallback(async () => {
    const list = await jsonRequest<CredentialSummary[]>("/api/credentials", csrfToken);
    setCredentials(list);
  }, [csrfToken]);

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
    setSelectedEdgeId(null);
    setCanvasMenu(null);
    setDirty(false);
    editRevisionRef.current = 0;
    failedRevisionRef.current = -1;
    setRunResult(null);
    setNodeTestResult(null);
    pastRef.current = [];
    futureRef.current = [];
    setHistoryAvailability({ canUndo: false, canRedo: false });
  }, [active, setEdges, setNodes]);

  const loadRuns = useCallback(async () => {
    try {
      setRuns(await jsonRequest<WorkflowRun[]>("/api/runs", csrfToken));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not load runs");
    }
  }, [csrfToken]);

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
    markDirty();
    setNotice("Undid graph change");
    setHistoryAvailability({
      canUndo: pastRef.current.length > 0,
      canRedo: true,
    });
  }, [edges, markDirty, nodes, setEdges, setNodes]);

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
    markDirty();
    setNotice("Redid graph change");
    setHistoryAvailability({
      canUndo: true,
      canRedo: futureRef.current.length > 0,
    });
  }, [edges, markDirty, nodes, setEdges, setNodes]);

  const copySelection = useCallback(() => {
    const copiedNodes = nodes.filter((node) => selectedNodeIds.has(node.id));
    if (!copiedNodes.length) return null;
    const copiedEdges = edges.filter(
      (edge) => selectedNodeIds.has(edge.source) && selectedNodeIds.has(edge.target),
    );
    const snapshot = cloneGraph(copiedNodes, copiedEdges);
    clipboardRef.current = snapshot;
    setNotice(`Copied ${copiedNodes.length} node${copiedNodes.length === 1 ? "" : "s"}`);
    return snapshot;
  }, [edges, nodes, selectedNodeIds]);

  const pasteSelection = useCallback((source?: GraphSnapshot | null) => {
    const snapshot = source ?? clipboardRef.current;
    if (!snapshot?.nodes.length) return;
    recordHistory();
    const ids = new Map<string, string>();
    for (const node of snapshot.nodes) ids.set(node.id, createNodeId(node.data.kind));
    const pastedNodes = snapshot.nodes.map((node) => ({
      ...structuredClone(node),
      id: ids.get(node.id)!,
      position: { x: node.position.x + 36, y: node.position.y + 36 },
      selected: true,
    }));
    const pastedEdges = snapshot.edges.map((edge, index) => ({
      ...structuredClone(edge),
      id: `${ids.get(edge.source)}-${edge.sourceHandle ?? "output"}-${ids.get(edge.target)}-${index}`,
      source: ids.get(edge.source)!,
      target: ids.get(edge.target)!,
      selected: false,
      type: "workflow",
    }));
    setNodes((items) => [
      ...items.map((node) => ({ ...node, selected: false })),
      ...pastedNodes,
    ]);
    setEdges((items) => [
      ...items.map((edge) => ({ ...edge, selected: false })),
      ...pastedEdges,
    ]);
    setSelectedId(pastedNodes.length === 1 ? pastedNodes[0].id : null);
    setSelectedEdgeId(null);
    clipboardRef.current = cloneGraph(pastedNodes, pastedEdges);
    markDirty();
    setNotice(`Pasted ${pastedNodes.length} node${pastedNodes.length === 1 ? "" : "s"}`);
  }, [markDirty, recordHistory, setEdges, setNodes]);

  const duplicateSelection = useCallback(() => {
    const snapshot = copySelection();
    if (snapshot) pasteSelection(snapshot);
  }, [copySelection, pasteSelection]);

  const deleteSelection = useCallback(() => {
    const nodeIds = selectedNodeIds;
    const edgeIds = new Set(
      edges
        .filter((edge) => edge.selected || edge.id === selectedEdgeId)
        .map((edge) => edge.id),
    );
    if (nodeIds.size === 0 && edgeIds.size === 0) return;
    recordHistory();
    setNodes((items) => items.filter((node) => !nodeIds.has(node.id)));
    setEdges((items) =>
      items.filter(
        (edge) =>
          !edgeIds.has(edge.id) &&
          !nodeIds.has(edge.source) &&
          !nodeIds.has(edge.target),
      ),
    );
    setSelectedId(null);
    setSelectedEdgeId(null);
    setNodeTestResult(null);
    markDirty();
    setNotice("Deleted selection");
  }, [edges, markDirty, recordHistory, selectedEdgeId, selectedNodeIds, setEdges, setNodes]);

  const selectAllNodes = useCallback(() => {
    setNodes((items) => items.map((node) => ({ ...node, selected: true })));
    setEdges((items) => items.map((edge) => ({ ...edge, selected: false })));
    setSelectedId(null);
    setSelectedEdgeId(null);
    setNotice(`Selected ${nodes.length} nodes`);
  }, [nodes.length, setEdges, setNodes]);

  const moveSelection = useCallback((x: number, y: number) => {
    if (!selectedNodeIds.size) return;
    recordHistory();
    setNodes((items) => items.map((node) =>
      selectedNodeIds.has(node.id)
        ? { ...node, position: { x: node.position.x + x, y: node.position.y + y } }
        : node,
    ));
    markDirty();
  }, [markDirty, recordHistory, selectedNodeIds, setNodes]);

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
      if (command && event.key.toLowerCase() === "a") {
        event.preventDefault();
        selectAllNodes();
        return;
      }
      if (command && event.key.toLowerCase() === "c") {
        event.preventDefault();
        copySelection();
        return;
      }
      if (command && event.key.toLowerCase() === "v") {
        event.preventDefault();
        pasteSelection();
        return;
      }
      if (command && event.key.toLowerCase() === "d") {
        event.preventDefault();
        duplicateSelection();
        return;
      }
      if (event.key === "?" || (event.key === "/" && event.shiftKey)) {
        event.preventDefault();
        setShortcutsOpen(true);
        return;
      }
      if (event.key === "Escape") {
        setCanvasMenu(null);
        setShortcutsOpen(false);
        return;
      }
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key) && selectedNodeIds.size) {
        event.preventDefault();
        const amount = event.shiftKey ? 20 : 2;
        moveSelection(
          event.key === "ArrowLeft" ? -amount : event.key === "ArrowRight" ? amount : 0,
          event.key === "ArrowUp" ? -amount : event.key === "ArrowDown" ? amount : 0,
        );
        return;
      }
      if (event.key === "Backspace" || event.key === "Delete") {
        event.preventDefault();
        deleteSelection();
      }
    };

    window.addEventListener("keydown", handleKeyboard);
    return () => window.removeEventListener("keydown", handleKeyboard);
  }, [copySelection, deleteSelection, duplicateSelection, moveSelection, pasteSelection, redo, selectAllNodes, selectedNodeIds.size, undo]);

  const persist = useCallback(
    async (enabledOverride?: boolean, options: { forceEnableInvalid?: boolean; reason?: string } = {}) => {
      if (!active) return null;
      if (savingRef.current) return null;
      const revisionAtStart = editRevisionRef.current;
      savingRef.current = true;
      setSaving(true);
      setSaveError("");
      setNotice("Saving…");
      try {
        const saved = await jsonRequest<Workflow>(
          "/api/workflows/" + active.id,
          csrfToken,
          {
            method: "PUT",
            body: JSON.stringify({
              name: active.name,
              slug: active.slug,
              description: active.description,
              tags: active.tags,
              enabled: enabledOverride ?? active.enabled,
              forceEnableInvalid: options.forceEnableInvalid,
              reason: options.reason ?? "saved",
              graph: {
                nodes: serializeNodes(nodes),
                edges: serializeEdges(edges),
              },
            }),
          },
        );
        if (editRevisionRef.current === revisionAtStart) setActive(saved);
        setWorkflows((items) =>
          items.map((item) => (item.id === saved.id ? saved : item)),
        );
        const hasNewerChanges = editRevisionRef.current !== revisionAtStart;
        setDirty(hasNewerChanges);
        setNotice(hasNewerChanges ? "Newer changes pending" : "Saved");
        return saved;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Save failed";
        failedRevisionRef.current = revisionAtStart;
        setSaveError(message);
        setNotice(message);
        return null;
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [active, csrfToken, edges, nodes],
  );

  useEffect(() => {
    if (!dirty || saving || !active || active.archivedAt || failedRevisionRef.current === editRevisionRef.current) return;
    const timer = window.setTimeout(() => {
      void persist(undefined, { reason: "autosave" });
    }, 900);
    return () => window.clearTimeout(timer);
  }, [active, dirty, edges, nodes, persist, saving]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty && !saving) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty, saving]);

  const allowNavigation = useCallback(() => {
    return (!dirty && !saving) || window.confirm("This workflow still has unsaved changes. Leave it anyway?");
  }, [dirty, saving]);

  const changeView = (next: typeof view) => {
    if (next !== view && view === "flow" && !allowNavigation()) return;
    setView(next);
  };

  const selectWorkflow = (workflow: Workflow) => {
    if (workflow.id !== active?.id && !allowNavigation()) return;
    setActive(workflow);
    setView("flow");
  };

  const createFlow = async () => {
    if (!allowNavigation()) return;
    try {
      const created = await jsonRequest<Workflow>("/api/workflows", csrfToken, {
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

  const openWorkflowSettings = async () => {
    if (!active) return;
    try {
      setVersions(await jsonRequest<WorkflowVersion[]>(`/api/workflows/${active.id}/versions`, csrfToken));
      setSettingsOpen(true);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not load versions");
    }
  };

  const patchWorkflowMetadata = (patch: Partial<Pick<Workflow, "name" | "slug" | "description" | "tags">>) => {
    if (!active) return;
    setActive({ ...active, ...patch });
    markDirty();
  };

  const workflowAction = async (action: "archive" | "restore" | "duplicate") => {
    if (!active) return;
    if (dirty && !(await persist())) return;
    if (action === "archive" && !window.confirm(`Archive ${active.name}? Scheduled and webhook execution will stop.`)) return;
    try {
      const result = await jsonRequest<Workflow>(`/api/workflows/${active.id}/${action}`, csrfToken, { method: "POST", body: "{}" });
      if (action === "duplicate") {
        setWorkflows((items) => [result, ...items]);
        hydratedWorkflowIdRef.current = null;
        setActive(result);
        setFlowFilter("active");
      } else {
        setWorkflows((items) => items.map((item) => item.id === result.id ? result : item));
        setActive(result);
        setFlowFilter(action === "archive" ? "archived" : "active");
      }
      setSettingsOpen(false);
      setNotice(action === "archive" ? "Archived" : action === "restore" ? "Restored" : "Duplicated");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Workflow action failed");
    }
  };

  const permanentlyDeleteWorkflow = async () => {
    if (!active || !window.confirm(`Permanently delete ${active.name} and its run history? This cannot be undone.`)) return;
    try {
      await jsonRequest(`/api/workflows/${active.id}`, csrfToken, { method: "DELETE" });
      const remaining = workflows.filter((item) => item.id !== active.id);
      setWorkflows(remaining);
      hydratedWorkflowIdRef.current = null;
      setActive(remaining.find((item) => !item.archivedAt) ?? remaining[0] ?? null);
      setSettingsOpen(false);
      setDirty(false);
      setNotice("Workflow deleted");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Delete failed");
    }
  };

  const exportActiveWorkflow = async () => {
    if (!active) return;
    const response = await fetch(`/api/workflows/${active.id}/export`);
    if (!response.ok) { setNotice("Export failed"); return; }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${active.slug}.9n9.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setNotice("Workflow exported");
  };

  const importWorkflowFile = async (file?: File) => {
    if (!file || !allowNavigation()) return;
    try {
      const imported = await jsonRequest<Workflow>("/api/workflows/import", csrfToken, { method: "POST", body: await file.text() });
      setWorkflows((items) => [imported, ...items]);
      hydratedWorkflowIdRef.current = null;
      setActive(imported);
      setFlowFilter("active");
      setView("flow");
      setNotice("Workflow imported disabled");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Import failed");
    } finally {
      if (importInputRef.current) importInputRef.current.value = "";
    }
  };

  const saveActiveAsTemplate = async () => {
    if (!active) return;
    if (dirty && !(await persist())) return;
    try {
      const template = await jsonRequest<WorkflowTemplate>("/api/templates", csrfToken, { method: "POST", body: JSON.stringify({ workflowId: active.id }) });
      setTemplates((items) => [...items, template].sort((a, b) => a.name.localeCompare(b.name)));
      setNotice("Template saved without credential bindings");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Template save failed");
    }
  };

  const instantiateWorkflowTemplate = async (template: WorkflowTemplate) => {
    if (!allowNavigation()) return;
    try {
      const workflow = await jsonRequest<Workflow>(`/api/templates/${template.id}/instantiate`, csrfToken, { method: "POST", body: "{}" });
      setWorkflows((items) => [workflow, ...items]);
      hydratedWorkflowIdRef.current = null;
      setActive(workflow);
      setFlowFilter("active");
      setView("flow");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not use template");
    }
  };

  const removeWorkflowTemplate = async (template: WorkflowTemplate) => {
    if (!window.confirm(`Delete template ${template.name}?`)) return;
    try {
      await jsonRequest(`/api/templates/${template.id}`, csrfToken, { method: "DELETE" });
      setTemplates((items) => items.filter((item) => item.id !== template.id));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not delete template");
    }
  };

  const restoreVersion = async (version: WorkflowVersion) => {
    if (!active || !window.confirm(`Restore version ${version.version}? The restored workflow will be disabled.`)) return;
    try {
      const restored = await jsonRequest<Workflow>(`/api/workflows/${active.id}/versions/${version.version}/restore`, csrfToken, { method: "POST", body: "{}" });
      hydratedWorkflowIdRef.current = null;
      setActive(restored);
      setWorkflows((items) => items.map((item) => item.id === restored.id ? restored : item));
      setSettingsOpen(false);
      setNotice(`Restored version ${version.version}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Version restore failed");
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
        headers: { "content-type": "application/json", "x-9n9-csrf": csrfToken },
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
          headers: { "content-type": "application/json", "x-9n9-csrf": csrfToken },
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
    if (active.archivedAt) {
      setNotice("Restore this workflow before enabling it");
      return;
    }
    const enabling = !active.enabled;
    let forceEnableInvalid = false;
    if (enabling && validationIssues.length > 0) {
      forceEnableInvalid = window.confirm(`This workflow has ${validationIssues.length} validation issue${validationIssues.length === 1 ? "" : "s"}. Enable it anyway?`);
      if (!forceEnableInvalid) return;
    }
    await persist(enabling, { forceEnableInvalid, reason: enabling ? "enabled" : "disabled" });
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
        config: { ...item.config, ...(nodeDefaults[item.kind] ?? {}) },
      },
    };
    setNodes((items) => [
      ...items.map((existing) => ({ ...existing, selected: false })),
      { ...node, selected: true },
    ]);
    setSelectedId(id);
    markDirty();
    setInspectorCollapsed(false);
    setNotice("Added " + item.title);
    setRecentKinds((current) => {
      const next = [item.kind, ...current.filter((kind) => kind !== item.kind)].slice(0, 5);
      localStorage.setItem("9n9.recent-nodes", JSON.stringify(next));
      return next;
    });

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
      const sourceNode = nodes.find((node) => node.id === source);
      const targetNode = nodes.find((node) => node.id === target);
      if (
        !sourceNode ||
        !targetNode ||
        sourceNode.data.kind.startsWith("annotation.") ||
        targetNode.data.kind.startsWith("annotation.") ||
        targetNode.data.kind.startsWith("trigger.")
      ) {
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
            type: "workflow",
            markerEnd: { type: MarkerType.ArrowClosed },
          },
          items,
        ),
      );
      markDirty();
      setNotice("Connected nodes");
    },
    [connectionAllowed, markDirty, recordHistory, setEdges],
  );

  const reconnect = useCallback((oldEdge: Edge, connection: Connection) => {
    const { source, target } = connection;
    const sourceNode = nodes.find((node) => node.id === source);
    const targetNode = nodes.find((node) => node.id === target);
    const remaining = edges.filter((edge) => edge.id !== oldEdge.id);
    const allowed = Boolean(
      source &&
      target &&
      source !== target &&
      sourceNode &&
      targetNode &&
      !sourceNode.data.kind.startsWith("annotation.") &&
      !targetNode.data.kind.startsWith("annotation.") &&
      !targetNode.data.kind.startsWith("trigger.") &&
      !remaining.some((edge) => edge.target === target) &&
      !remaining.some((edge) => edge.source === source && edge.target === target && edge.sourceHandle === connection.sourceHandle) &&
      !wouldCreateCycle(source, target, remaining),
    );
    if (!allowed) {
      setNotice("That reconnection is not allowed");
      return;
    }
    recordHistory();
    setEdges((items) => reconnectEdge(oldEdge, connection, items));
    markDirty();
    setNotice("Reconnected edge");
  }, [edges, markDirty, nodes, recordHistory, setEdges]);

  const updateEdgeLabel = useCallback((id: string, label: string) => {
    setEdges((items) => items.map((edge) => edge.id === id ? { ...edge, label } : edge));
    markDirty();
  }, [markDirty, setEdges]);

  const removeEdge = useCallback((id: string) => {
    recordHistory();
    setEdges((items) => items.filter((edge) => edge.id !== id));
    setSelectedEdgeId(null);
    markDirty();
    setNotice("Deleted edge");
  }, [markDirty, recordHistory, setEdges]);

  const autoLayout = useCallback(() => {
    const executable = nodes.filter((node) => !node.data.kind.startsWith("annotation."));
    if (!executable.length) return;
    recordHistory();
    const ids = new Set(executable.map((node) => node.id));
    const level = new Map(executable.map((node) => [node.id, 0]));
    const incoming = new Map(executable.map((node) => [node.id, 0]));
    for (const edge of edges) {
      if (ids.has(edge.source) && ids.has(edge.target)) {
        incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
      }
    }
    const queue = executable.filter((node) => incoming.get(node.id) === 0).map((node) => node.id);
    while (queue.length) {
      const id = queue.shift()!;
      for (const edge of edges.filter((candidate) => candidate.source === id && ids.has(candidate.target))) {
        level.set(edge.target, Math.max(level.get(edge.target) ?? 0, (level.get(id) ?? 0) + 1));
        incoming.set(edge.target, (incoming.get(edge.target) ?? 1) - 1);
        if (incoming.get(edge.target) === 0) queue.push(edge.target);
      }
    }
    const rows = new Map<number, number>();
    setNodes((items) => items.map((node) => {
      if (!ids.has(node.id)) return node;
      const column = level.get(node.id) ?? 0;
      const row = rows.get(column) ?? 0;
      rows.set(column, row + 1);
      return { ...node, position: { x: 80 + column * 280, y: 80 + row * 120 } };
    }));
    markDirty();
    setNotice("Applied automatic layout");
    requestAnimationFrame(() => void flowInstance?.fitView({ duration: 300, padding: 0.18 }));
  }, [edges, flowInstance, markDirty, nodes, recordHistory, setNodes]);

  const zoomToSelected = useCallback(() => {
    const selected = nodes.filter((node) => selectedNodeIds.has(node.id));
    if (!selected.length) {
      setNotice("Select one or more nodes first");
      return;
    }
    void flowInstance?.fitView({ nodes: selected, duration: 250, padding: 0.35, maxZoom: 1.25 });
  }, [flowInstance, nodes, selectedNodeIds]);

  const saveNodeDefault = useCallback(() => {
    if (!selectedNode || selectedNode.data.kind.startsWith("annotation.")) return;
    const next = { ...nodeDefaults, [selectedNode.data.kind]: structuredClone(selectedNode.data.config) };
    setNodeDefaults(next);
    localStorage.setItem("9n9.node-defaults", JSON.stringify(next));
    setNotice(`${selectedNode.data.label} settings saved as the node default`);
  }, [nodeDefaults, selectedNode]);

  const resetNodeDefault = useCallback(() => {
    if (!selectedNode) return;
    const next = { ...nodeDefaults };
    delete next[selectedNode.data.kind];
    setNodeDefaults(next);
    localStorage.setItem("9n9.node-defaults", JSON.stringify(next));
    setNotice("Node default reset");
  }, [nodeDefaults, selectedNode]);

  const handleNodesChange = useCallback(
    (changes: NodeChange<N9nFlowNode>[]) => {
      onNodesChange(changes);
      if (changesWorkflowNodes(changes)) markDirty();
    },
    [markDirty, onNodesChange],
  );

  const handleEdgesChange = useCallback(
    (changes: EdgeChange<Edge>[]) => {
      onEdgesChange(changes);
      if (changesWorkflowEdges(changes)) markDirty();
    },
    [markDirty, onEdgesChange],
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
    markDirty();
  };

  const updateConfig = (key: string, value: unknown) => {
    if (!selectedNode) return;
    updateNode({
      config: { ...selectedNode.data.config, [key]: value },
    });
  };

  const updateSample = (mode: SampleMode, value: unknown) => {
    if (!selectedNode) return;
    updateNode({
      samples: { ...selectedNode.data.samples, [mode]: value },
    });
  };

  const pinRunSamples = (run: WorkflowRun, mode: SampleMode) => {
    recordHistory();
    const outputs = new Map(run.trace.map((trace) => [trace.nodeId, trace.output]));
    setNodes((items) => items.map((node) => {
      const value = node.data.kind.startsWith("trigger.") ? run.input : outputs.get(node.id);
      if (value === undefined) return node;
      return {
        ...node,
        data: {
          ...node.data,
          samples: { ...node.data.samples, [mode]: structuredClone(value) },
        },
      };
    }));
    markDirty();
    setNotice(`Pinned run data to ${mode} samples`);
  };

  const removeSelected = () => {
    deleteSelection();
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

  const rotateWebhook = async () => {
    if (!active) return null;
    const result = await jsonRequest<{ token: string }>(
      `/api/workflows/${active.id}/webhook-token`,
      csrfToken,
      { method: "POST", body: "{}" },
    );
    const updated = { ...active, webhookProtected: true, webhookToken: result.token };
    setActive(updated);
    setWorkflows((items) => items.map((item) => item.id === updated.id ? updated : item));
    setNotice("Webhook token rotated");
    return result.token;
  };

  const logout = async () => {
    try {
      await jsonRequest("/api/auth/logout", csrfToken, { method: "POST", body: "{}" });
      window.location.reload();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not sign out");
    }
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
            onClick={() => changeView("flow")}
          >
            <Zap size={17} /> Flows
          </button>
          <button
            className={view === "runs" ? "is-active" : ""}
            onClick={() => changeView("runs")}
          >
            <History size={17} /> Runs
          </button>
          <button className={view === "templates" ? "is-active" : ""} onClick={() => changeView("templates")}>
            <LayoutTemplate size={17} /> Templates
          </button>
          <button className={view === "credentials" ? "is-active" : ""} onClick={() => changeView("credentials")}>
            <KeyRound size={17} /> Credentials
          </button>
          <button className={view === "audit" ? "is-active" : ""} onClick={() => changeView("audit")}>
            <ShieldCheck size={17} /> Audit
          </button>
          <button className={view === "account" ? "is-active" : ""} onClick={() => changeView("account")}>
            <UserRound size={17} /> Security
          </button>
        </nav>

        <div className="sidebar__section-title">
          <span>Your flows</span>
          <button onClick={createFlow} aria-label="Create flow">
            <Plus size={15} />
          </button>
          <button onClick={() => importInputRef.current?.click()} aria-label="Import workflow">
            <Upload size={14} />
          </button>
        </div>

        <input ref={importInputRef} className="file-input" type="file" accept="application/json,.json" onChange={(event) => void importWorkflowFile(event.target.files?.[0])} />
        <div className="flow-filters">
          <label><Search size={13} /><input aria-label="Search workflows" placeholder="Search flows" value={flowSearch} onChange={(event) => setFlowSearch(event.target.value)} /></label>
          <div>
            <select aria-label="Workflow status filter" value={flowFilter} onChange={(event) => setFlowFilter(event.target.value as typeof flowFilter)}>
              <option value="active">Active</option><option value="archived">Archived</option><option value="all">All</option>
            </select>
            <select aria-label="Workflow sort" value={flowSort} onChange={(event) => setFlowSort(event.target.value as typeof flowSort)}>
              <option value="updated">Updated</option><option value="created">Created</option><option value="name">Name</option>
            </select>
          </div>
        </div>

        <div className="flow-list">
          {visibleWorkflows.map((workflow) => (
            <button
              key={workflow.id}
              className={active?.id === workflow.id ? "is-active" : ""}
              onClick={() => selectWorkflow(workflow)}
            >
              <span
                className={
                  "flow-list__dot " +
                  (workflow.archivedAt ? "is-archived" : workflow.enabled ? "is-enabled" : "")
                }
              />
              <span>{workflow.name}</span>
              <ChevronRight size={14} />
            </button>
          ))}
          {!visibleWorkflows.length && <div className="flow-list__empty">No matching flows</div>}
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
          <button className="sidebar__logout" onClick={logout} title={`Sign out ${username}`} aria-label="Sign out"><LogOut size={14} /></button>
        </div>
      </aside>

      <section className="workspace">
        {view === "templates" ? (
          <TemplatesView templates={templates} onUse={instantiateWorkflowTemplate} onDelete={removeWorkflowTemplate} />
        ) : view === "credentials" ? (
          <CredentialsView csrfToken={csrfToken} credentials={credentials} onRefresh={loadCredentials} />
        ) : view === "audit" ? (
          <AuditView csrfToken={csrfToken} />
        ) : view === "account" ? (
          <AccountView csrfToken={csrfToken} username={username} />
        ) : view === "runs" ? (
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
                    markDirty();
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
                <button className="icon-button" onClick={() => void openWorkflowSettings()} aria-label="Workflow settings" title="Workflow settings">
                  <Settings2 size={15} />
                </button>
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
                <button className="icon-button" onClick={() => setShortcutsOpen(true)} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">
                  <Keyboard size={15} />
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
                <span className={"save-state " + (saveError ? "has-error" : "")} title={saveError || notice}>
                  {saving ? "Saving…" : saveError ? "Save error" : dirty ? "Autosave pending" : notice}
                </span>
                <button
                  className={
                    "toggle " + (active.enabled ? "is-enabled" : "")
                  }
                  onClick={toggleEnabled}
                  disabled={Boolean(active.archivedAt)}
                  aria-label={active.enabled ? "Disable flow" : "Enable flow"}
                >
                  <span />
                  {active.archivedAt ? "Archived" : active.enabled ? "Live" : "Off"}
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
                  disabled={running || Boolean(active.archivedAt)}
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

            <div className={`studio${paletteCollapsed ? " is-palette-collapsed" : ""}${inspectorCollapsed ? " is-inspector-collapsed" : ""}`}>
              {paletteCollapsed ? (
                <button className="panel-reopen panel-reopen--left" onClick={() => setPaletteCollapsed(false)} aria-label="Open node palette"><ChevronRight size={15} /></button>
              ) : (
                <NodePalette
                  onAdd={addNode}
                  onCollapse={() => setPaletteCollapsed(true)}
                  search={nodeSearch}
                  onSearch={setNodeSearch}
                  recentKinds={recentKinds}
                />
              )}

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
                <div className="canvas-toolbar" aria-label="Canvas tools">
                  <button onClick={autoLayout} title="Automatic layout" aria-label="Automatic layout"><LayoutDashboard size={14} /></button>
                  <button onClick={zoomToSelected} title="Zoom to selected" aria-label="Zoom to selected"><Search size={14} /></button>
                  <button onClick={() => setShortcutsOpen(true)} title="Keyboard shortcuts" aria-label="Keyboard shortcuts"><Keyboard size={14} /></button>
                </div>
                <WorkflowEdgeActionsProvider actions={{ updateLabel: updateEdgeLabel, remove: removeEdge }}>
                <ReactFlow
                  nodes={renderNodes}
                  edges={renderEdges}
                  nodeTypes={nodeTypes}
                  edgeTypes={edgeTypes}
                  onNodesChange={handleNodesChange}
                  onEdgesChange={handleEdgesChange}
                  onConnect={connect}
                  onReconnect={reconnect}
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
                    setSelectedEdgeId(null);
                    setInspectorCollapsed(false);
                    if (nodeTestResult?.nodeId !== node.id) {
                      setNodeTestResult(null);
                    }
                  }}
                  onNodeContextMenu={(event, node) => {
                    event.preventDefault();
                    setNodes((items) => items.map((item) => ({ ...item, selected: item.id === node.id || (item.selected && node.selected) })));
                    setSelectedId(node.id);
                    setSelectedEdgeId(null);
                    setCanvasMenu({ x: event.clientX, y: event.clientY, kind: "node", id: node.id });
                  }}
                  onEdgeClick={(_, edge) => { setSelectedId(null); setSelectedEdgeId(edge.id); }}
                  onEdgeContextMenu={(event, edge) => {
                    event.preventDefault();
                    setSelectedId(null);
                    setSelectedEdgeId(edge.id);
                    setEdges((items) => items.map((item) => ({ ...item, selected: item.id === edge.id })));
                    setCanvasMenu({ x: event.clientX, y: event.clientY, kind: "edge", id: edge.id });
                  }}
                  onSelectionChange={({ nodes: selectedNodes, edges: selectedEdges }) => {
                    setSelectedId(selectedNodes.length === 1 ? selectedNodes[0].id : null);
                    setSelectedEdgeId(selectedEdges.length === 1 ? selectedEdges[0].id : null);
                  }}
                  onPaneClick={() => {
                    setSelectedId(null);
                    setSelectedEdgeId(null);
                    setCanvasMenu(null);
                    setValidationOpen(false);
                  }}
                  onPaneContextMenu={(event) => {
                    event.preventDefault();
                    setCanvasMenu({
                      x: event.clientX,
                      y: event.clientY,
                      kind: "pane",
                      flowPosition: flowInstance?.screenToFlowPosition({ x: event.clientX, y: event.clientY }),
                    });
                  }}
                  fitView
                  minZoom={0.35}
                  maxZoom={1.7}
                  connectionMode={ConnectionMode.Strict}
                  connectionRadius={28}
                  selectionOnDrag
                  selectionMode={SelectionMode.Partial}
                  panOnDrag={[1, 2]}
                  multiSelectionKeyCode={["Meta", "Control", "Shift"]}
                  snapToGrid
                  snapGrid={[20, 20]}
                  defaultEdgeOptions={{
                    type: "workflow",
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
                  <MiniMap pannable zoomable nodeStrokeWidth={2} ariaLabel="Workflow minimap" />
                </ReactFlow>
                </WorkflowEdgeActionsProvider>

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
                {canvasMenu && (
                  <CanvasContextMenu
                    menu={canvasMenu}
                    onClose={() => setCanvasMenu(null)}
                    onCopy={() => { copySelection(); setCanvasMenu(null); }}
                    onDuplicate={() => { duplicateSelection(); setCanvasMenu(null); }}
                    onDelete={() => { deleteSelection(); setCanvasMenu(null); }}
                    onDeleteEdge={() => { if (canvasMenu.id) removeEdge(canvasMenu.id); setCanvasMenu(null); }}
                    onLabelEdge={() => { setSelectedEdgeId(canvasMenu.id ?? null); setCanvasMenu(null); }}
                    onSticky={() => {
                      const item = palette.find((candidate) => candidate.kind === "annotation.sticky");
                      if (item) addNode(item, canvasMenu.flowPosition);
                      setCanvasMenu(null);
                    }}
                    onGroup={() => {
                      const item = palette.find((candidate) => candidate.kind === "annotation.group");
                      if (item) addNode(item, canvasMenu.flowPosition);
                      setCanvasMenu(null);
                    }}
                    onPaste={() => { pasteSelection(); setCanvasMenu(null); }}
                    onLayout={() => { autoLayout(); setCanvasMenu(null); }}
                  />
                )}
              </div>

              {inspectorCollapsed ? (
                <button className="panel-reopen panel-reopen--right" onClick={() => setInspectorCollapsed(false)} aria-label="Open inspector"><ChevronLeft size={15} /></button>
              ) : <Inspector
                node={selectedNode}
                workflow={active}
                nodes={nodes}
                edges={edges}
                onLabel={(value) => updateNode({ label: value })}
                onConfig={updateConfig}
                onNotes={(value) => updateNode({ notes: value })}
                onSample={updateSample}
                runs={runs.filter((run) => run.workflowId === active.id)}
                onPinRun={pinRunSamples}
                onRemove={removeSelected}
                onCollapse={() => setInspectorCollapsed(true)}
                onSaveDefault={saveNodeDefault}
                onResetDefault={resetNodeDefault}
                hasDefault={Boolean(selectedNode && nodeDefaults[selectedNode.data.kind])}
                testInput={nodeTestInput}
                onTestInput={setNodeTestInput}
                testResult={nodeTestResult}
                testing={testingNodeId === selectedNode?.id}
                onTest={() => void testSelectedNode()}
                credentials={credentials}
                onRotateWebhook={rotateWebhook}
              />}
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
      {settingsOpen && active && (
        <WorkflowSettings
          workflow={active}
          versions={versions}
          onPatch={patchWorkflowMetadata}
          onClose={() => setSettingsOpen(false)}
          onArchive={() => void workflowAction("archive")}
          onRestore={() => void workflowAction("restore")}
          onDuplicate={() => void workflowAction("duplicate")}
          onDelete={() => void permanentlyDeleteWorkflow()}
          onExport={() => void exportActiveWorkflow()}
          onSaveTemplate={() => void saveActiveAsTemplate()}
          onRestoreVersion={(version) => void restoreVersion(version)}
        />
      )}
      {shortcutsOpen && <ShortcutHelp onClose={() => setShortcutsOpen(false)} />}
    </main>
  );
}

function WorkflowSettings({
  workflow,
  versions,
  onPatch,
  onClose,
  onArchive,
  onRestore,
  onDuplicate,
  onDelete,
  onExport,
  onSaveTemplate,
  onRestoreVersion,
}: {
  workflow: Workflow;
  versions: WorkflowVersion[];
  onPatch: (patch: Partial<Pick<Workflow, "name" | "slug" | "description" | "tags">>) => void;
  onClose: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onExport: () => void;
  onSaveTemplate: () => void;
  onRestoreVersion: (version: WorkflowVersion) => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="workflow-settings" role="dialog" aria-modal="true" aria-label="Workflow settings">
        <header><div><span>Workflow management</span><h2>{workflow.name}</h2></div><button onClick={onClose} aria-label="Close workflow settings"><X size={16} /></button></header>
        <div className="workflow-settings__body">
          <div className="workflow-settings__fields">
            <Field label="Name"><input aria-label="Workflow name" value={workflow.name} onChange={(event) => onPatch({ name: event.target.value })} /></Field>
            <Field label="Webhook slug" hint="Unique lowercase letters, numbers, and hyphens."><input aria-label="Webhook slug" value={workflow.slug} onChange={(event) => onPatch({ slug: event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") })} /></Field>
            <Field label="Description"><textarea aria-label="Workflow description" rows={5} value={workflow.description} onChange={(event) => onPatch({ description: event.target.value })} /></Field>
            <Field label="Tags" hint="Comma separated, up to 12 tags."><input aria-label="Workflow tags" value={workflow.tags.join(", ")} onChange={(event) => onPatch({ tags: event.target.value.split(",").map((tag) => tag.trim()).filter(Boolean) })} /></Field>
            <div className="workflow-actions">
              <button className="button button--quiet" onClick={onDuplicate}><Copy size={14} /> Duplicate</button>
              <button className="button button--quiet" onClick={onExport}><Download size={14} /> Export JSON</button>
              <button className="button button--quiet" onClick={onSaveTemplate}><LayoutTemplate size={14} /> Save template</button>
              {workflow.archivedAt ? (
                <button className="button button--quiet" onClick={onRestore}><Archive size={14} /> Restore archive</button>
              ) : (
                <button className="button button--quiet" onClick={onArchive}><Archive size={14} /> Archive</button>
              )}
              <button className="button button--danger" onClick={onDelete}><X size={14} /> Delete permanently</button>
            </div>
          </div>
          <section className="version-history">
            <header><History size={15} /><strong>Version history</strong><small>{versions.length} saved</small></header>
            <div>
              {versions.map((version) => (
                <article key={version.id}>
                  <div><strong>v{version.version}</strong><span>{version.reason}</span><small>{formatTime(version.createdAt)}</small></div>
                  <button className="button button--quiet" onClick={() => onRestoreVersion(version)}>Restore</button>
                </article>
              ))}
              {!versions.length && <p>No saved versions yet.</p>}
            </div>
          </section>
        </div>
      </section>
    </div>
  );
}

function TemplatesView({ templates, onUse, onDelete }: {
  templates: WorkflowTemplate[];
  onUse: (template: WorkflowTemplate) => void;
  onDelete: (template: WorkflowTemplate) => void;
}) {
  return (
    <div className="security-view">
      <header className="runs-header"><div><span>Reusable starting points</span><h1>Templates</h1></div></header>
      <div className="template-grid">
        {templates.map((template) => (
          <article key={template.id}>
            <div className="template-grid__icon"><LayoutTemplate size={20} /></div>
            <h2>{template.name}</h2>
            <p>{template.description || "No description"}</p>
            <div>{template.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
            <small>{template.graph.nodes.length} nodes · updated {formatTime(template.updatedAt)}</small>
            <footer><button className="button button--run" onClick={() => onUse(template)}><Plus size={14} /> Use template</button><button className="button button--danger" onClick={() => onDelete(template)}>Delete</button></footer>
          </article>
        ))}
        {!templates.length && <div className="runs-empty">Save any workflow as a template from Workflow settings.</div>}
      </div>
    </div>
  );
}

function NodePalette({
  onAdd,
  onCollapse,
  search,
  onSearch,
  recentKinds,
}: {
  onAdd: (item: (typeof palette)[number]) => void;
  onCollapse: () => void;
  search: string;
  onSearch: (value: string) => void;
  recentKinds: NodeKind[];
}) {
  const groups = ["Triggers", "Actions", "Data", "Logic", "Canvas"];
  const query = search.trim().toLowerCase();
  const visible = palette.filter((item) =>
    !query || item.title.toLowerCase().includes(query) || item.kind.includes(query) || item.group.toLowerCase().includes(query),
  );
  const recent = recentKinds
    .map((kind) => palette.find((item) => item.kind === kind))
    .filter((item): item is (typeof palette)[number] => Boolean(item))
    .filter((item) => visible.includes(item));
  const button = (item: (typeof palette)[number]) => {
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
  };
  return (
    <aside className="palette">
      <div className="panel-title">
        <span>Nodes</span>
        <button onClick={onCollapse} aria-label="Collapse node palette" title="Collapse palette"><PanelLeftClose size={14} /></button>
      </div>
      <label className="node-search"><Search size={13} /><input aria-label="Search nodes" placeholder="Search nodes" value={search} onChange={(event) => onSearch(event.target.value)} /></label>
      {recent.length > 0 && !query && (
        <div className="palette__group palette__recent"><span>Recent</span>{recent.map(button)}</div>
      )}
      {groups.map((group) => (
        <div className="palette__group" key={group}>
          <span>{group}</span>
          {visible
            .filter((item) => item.group === group)
            .map(button)}
        </div>
      ))}
      {!visible.length && <div className="palette__empty">No matching nodes</div>}
      <div className="template-tip">
        <Braces size={14} />
        Use <code>{"{{input.body}}"}</code> or{" "}
        <code>{"{{steps.nodeId.body}}"}</code>
      </div>
    </aside>
  );
}

function CanvasContextMenu({
  menu,
  onClose,
  onCopy,
  onDuplicate,
  onDelete,
  onDeleteEdge,
  onLabelEdge,
  onSticky,
  onGroup,
  onPaste,
  onLayout,
}: {
  menu: CanvasMenu;
  onClose: () => void;
  onCopy: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onDeleteEdge: () => void;
  onLabelEdge: () => void;
  onSticky: () => void;
  onGroup: () => void;
  onPaste: () => void;
  onLayout: () => void;
}) {
  return (
    <div className="canvas-context" role="menu" aria-label="Canvas context menu" style={{ left: menu.x, top: menu.y }} onMouseLeave={onClose}>
      {menu.kind === "node" ? (
        <><button role="menuitem" onClick={onCopy}><Copy size={13} /> Copy <kbd>⌘C</kbd></button><button role="menuitem" onClick={onDuplicate}><Plus size={13} /> Duplicate <kbd>⌘D</kbd></button><button role="menuitem" className="is-danger" onClick={onDelete}><X size={13} /> Delete <kbd>⌫</kbd></button></>
      ) : menu.kind === "edge" ? (
        <><button role="menuitem" onClick={onLabelEdge}><Braces size={13} /> Edit label</button><button role="menuitem" className="is-danger" onClick={onDeleteEdge}><X size={13} /> Delete edge</button></>
      ) : (
        <><button role="menuitem" onClick={onPaste}><Copy size={13} /> Paste <kbd>⌘V</kbd></button><button role="menuitem" onClick={onSticky}><StickyNote size={13} /> Add sticky note</button><button role="menuitem" onClick={onGroup}><PanelsTopLeft size={13} /> Add canvas group</button><button role="menuitem" onClick={onLayout}><LayoutDashboard size={13} /> Automatic layout</button></>
      )}
    </div>
  );
}

function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const shortcuts = [
    ["Select all nodes", "Ctrl/Cmd + A"],
    ["Copy selection", "Ctrl/Cmd + C"],
    ["Paste selection", "Ctrl/Cmd + V"],
    ["Duplicate selection", "Ctrl/Cmd + D"],
    ["Undo / redo", "Ctrl/Cmd + Z / Shift + Z"],
    ["Move selection", "Arrow keys"],
    ["Move by grid", "Shift + Arrow keys"],
    ["Delete selection", "Backspace / Delete"],
    ["Close menus", "Escape"],
    ["Open this help", "?"],
  ];
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="shortcut-help" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
        <header><div><span>Editor reference</span><h2>Keyboard shortcuts</h2></div><button onClick={onClose} aria-label="Close keyboard shortcuts"><X size={16} /></button></header>
        <div>{shortcuts.map(([name, keys]) => <p key={name}><span>{name}</span><kbd>{keys}</kbd></p>)}</div>
      </section>
    </div>
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

function ExpressionEditor({
  value,
  onChange,
  onFocus,
  paths,
  rows,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  onFocus: () => void;
  paths: string[];
  rows: number;
  ariaLabel: string;
}) {
  const [focused, setFocused] = useState(false);
  const overlayRef = useRef<HTMLPreElement>(null);
  const lastOpen = value.lastIndexOf("{{");
  const lastClose = value.lastIndexOf("}}");
  const fragment = lastOpen > lastClose ? value.slice(lastOpen + 2).trim().toLowerCase() : "";
  const suggestions = focused && lastOpen > lastClose
    ? [...new Set(paths)].filter((path) => !fragment || path.toLowerCase().includes(fragment)).slice(0, 8)
    : [];
  const complete = (path: string) => {
    onChange(value.slice(0, lastOpen) + `{{${path}}}`);
  };
  const highlighted = value.split(/(\{\{[\s\S]*?\}\})/g).map((part, index) =>
    part.startsWith("{{") && part.endsWith("}}")
      ? <mark key={index}>{part}</mark>
      : <span key={index}>{part}</span>,
  );
  return (
    <div className={`expression-editor${focused ? " is-focused" : ""}`}>
      <pre ref={overlayRef} aria-hidden="true">{highlighted}{"\n"}</pre>
      <textarea
        aria-label={ariaLabel}
        rows={rows}
        value={value}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        onFocus={() => { setFocused(true); onFocus(); }}
        onBlur={() => window.setTimeout(() => setFocused(false), 100)}
        onScroll={(event) => {
          if (!overlayRef.current) return;
          overlayRef.current.scrollTop = event.currentTarget.scrollTop;
          overlayRef.current.scrollLeft = event.currentTarget.scrollLeft;
        }}
      />
      {suggestions.length > 0 && (
        <div className="expression-autocomplete" role="listbox" aria-label={`${ariaLabel} autocomplete`}>
          {suggestions.map((path) => <button key={path} role="option" aria-selected="false" onMouseDown={(event) => event.preventDefault()} onClick={() => complete(path)}><Braces size={11} />{path}</button>)}
        </div>
      )}
    </div>
  );
}

function Inspector({
  node,
  workflow,
  nodes,
  edges,
  onLabel,
  onConfig,
  onNotes,
  onSample,
  runs,
  onPinRun,
  onRemove,
  onCollapse,
  onSaveDefault,
  onResetDefault,
  hasDefault,
  testInput,
  onTestInput,
  testResult,
  testing,
  onTest,
  credentials,
  onRotateWebhook,
}: {
  node: N9nFlowNode | null;
  workflow: Workflow;
  nodes: N9nFlowNode[];
  edges: Edge[];
  onLabel: (value: string) => void;
  onConfig: (key: string, value: unknown) => void;
  onNotes: (value: string) => void;
  onSample: (mode: SampleMode, value: unknown) => void;
  runs: WorkflowRun[];
  onPinRun: (run: WorkflowRun, mode: SampleMode) => void;
  onRemove: () => void;
  onCollapse: () => void;
  onSaveDefault: () => void;
  onResetDefault: () => void;
  hasDefault: boolean;
  testInput: string;
  onTestInput: (value: string) => void;
  testResult: NodeTestResult | null;
  testing: boolean;
  onTest: () => void;
  credentials: CredentialSummary[];
  onRotateWebhook: () => Promise<string | null>;
}) {
  const availableFields = node ? (templateFields[node.data.kind] ?? []) : [];
  const [expressionTarget, setExpressionTarget] = useState("");
  const [sampleMode, setSampleMode] = useState<SampleMode>("development");
  const [dataSource, setDataSource] = useState("pinned");
  const [pathQuery, setPathQuery] = useState("");
  const [sampleDraft, setSampleDraft] = useState("{}");
  const [sampleError, setSampleError] = useState("");
  const [shownWebhookToken, setShownWebhookToken] = useState(workflow.webhookToken ?? "");
  useEffect(() => {
    setShownWebhookToken(workflow.webhookToken ?? "");
  }, [workflow.id, workflow.webhookToken]);
  useEffect(() => {
    setSampleDraft(JSON.stringify(node?.data.samples?.[sampleMode] ?? {}, null, 2));
    setSampleError("");
  }, [node?.id, node?.data.samples, sampleMode]);
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
  const defaultInputSample = {
    body: { message: "Hello from 9n9", status: "ok", items: [{ name: "first", value: 42 }] },
    files: { document: { name: "example.pdf", mimeType: "application/pdf", size: 1024 } },
    binary: { attachment: { fileName: "example.bin", mimeType: "application/octet-stream", size: 256 } },
  };
  const trigger = nodes.find((item) => item.data.kind.startsWith("trigger."));
  const selectedRun = runs.find((run) => run.id === dataSource);
  const pinnedSteps = Object.fromEntries(
    nodes
      .filter((item) => upstreamIds.has(item.id) && item.data.samples?.[sampleMode] !== undefined)
      .map((item) => [item.id, item.data.samples?.[sampleMode]]),
  );
  const runSteps = selectedRun
    ? Object.fromEntries(selectedRun.trace.filter((trace) => trace.output !== undefined).map((trace) => [trace.nodeId, trace.output]))
    : {};
  const expressionContext: TemplateContext = selectedRun
    ? { input: selectedRun.input ?? {}, steps: runSteps }
    : { input: trigger?.data.samples?.[sampleMode] ?? defaultInputSample, steps: pinnedSteps };
  const paths = [
    ...nodes.filter((item) => upstreamIds.has(item.id)).map((item) => ({ path: `steps.${item.id}`, value: expressionContext.steps[item.id] })),
    ...expressionPaths(expressionContext),
  ]
    .filter((entry, index, items) => items.findIndex((candidate) => candidate.path === entry.path) === index)
    .filter((entry) => !entry.path.startsWith("steps.") || upstreamIds.has(entry.path.split(".")[1]))
    .filter((entry) => !pathQuery.trim() || entry.path.toLowerCase().includes(pathQuery.trim().toLowerCase()));
  const preview = activeExpressionTarget
    ? previewTemplate(text(activeExpressionTarget), expressionContext)
    : { value: undefined, diagnostics: [], expressions: [] };
  const insertExpression = (expression: string) => {
    if (!activeExpressionTarget) return;
    const current = text(activeExpressionTarget);
    const separator = current && !/\s$/.test(current) ? " " : "";
    onConfig(activeExpressionTarget, current + separator + expression);
  };
  const appendExpressionSyntax = (syntax: string) => {
    if (!activeExpressionTarget) return;
    const current = text(activeExpressionTarget);
    const close = current.lastIndexOf("}}");
    if (close >= 0) onConfig(activeExpressionTarget, current.slice(0, close) + syntax + current.slice(close));
    else onConfig(activeExpressionTarget, current + `{{input.body${syntax}}}`);
  };
  const commitSample = () => {
    try {
      onSample(sampleMode, JSON.parse(sampleDraft));
      setSampleError("");
    } catch {
      setSampleError("Sample must be valid JSON");
    }
  };

  return (
    <aside className="inspector">
      <div className="panel-title">
        <span>Configure</span>
        <div><small>{node.data.kind}</small><button onClick={onCollapse} aria-label="Collapse inspector" title="Collapse inspector"><PanelRightClose size={14} /></button></div>
      </div>

      <Field label="Name">
        <input
          value={node.data.label}
          onChange={(event) => onLabel(event.target.value)}
        />
      </Field>

      {node.data.kind === "annotation.sticky" && (
        <>
          <Field label="Text"><textarea aria-label="Sticky note text" rows={8} value={text("text")} onChange={textarea("text")} /></Field>
          <Field label="Color"><select aria-label="Sticky note color" value={text("color") || "yellow"} onChange={(event) => onConfig("color", event.target.value)}><option value="yellow">Yellow</option><option value="purple">Purple</option><option value="blue">Blue</option><option value="green">Green</option></select></Field>
        </>
      )}

      {node.data.kind === "annotation.group" && (
        <>
          <div className="field-row"><Field label="Width"><input aria-label="Group width" type="number" min="240" max="1200" value={text("width") || "380"} onChange={input("width")} /></Field><Field label="Height"><input aria-label="Group height" type="number" min="140" max="900" value={text("height") || "220"} onChange={input("height")} /></Field></div>
          <Field label="Color"><select aria-label="Group color" value={text("color") || "purple"} onChange={(event) => onConfig("color", event.target.value)}><option value="purple">Purple</option><option value="blue">Blue</option><option value="green">Green</option><option value="orange">Orange</option></select></Field>
        </>
      )}

      {node.data.kind === "action.codex" && (
        <>
          <Field
            label="Prompt"
            hint="Runs through your authenticated local Codex container."
          >
            <ExpressionEditor ariaLabel="Prompt" rows={10} value={text("prompt")} paths={paths.map((entry) => entry.path)} onChange={(value) => onConfig("prompt", value)} onFocus={() => setExpressionTarget("prompt")} />
          </Field>
          <Field label="Workspace">
            <ExpressionEditor ariaLabel="Workspace" rows={2} value={text("cwd") || "/workspace"} paths={paths.map((entry) => entry.path)} onChange={(value) => onConfig("cwd", value)} onFocus={() => setExpressionTarget("cwd")} />
          </Field>
        </>
      )}

      {node.data.kind === "action.http" && (
        <>
          <Field label="Credential" hint="Secrets are injected only on the server and never enter expressions.">
            <select aria-label="Credential" value={text("credentialId")} onChange={(event) => onConfig("credentialId", event.target.value)}>
              <option value="">No credential</option>
              {credentials.filter((credential) => credential.type !== "ssh_key").map((credential) => (
                <option key={credential.id} value={credential.id}>{credential.name} · {credential.masked}</option>
              ))}
            </select>
          </Field>
          <Field label="Method">
            <select value={text("method") || "GET"} onChange={(event) => onConfig("method", event.target.value)}>
              {["GET", "POST", "PUT", "PATCH", "DELETE"].map((method) => (
                <option key={method}>{method}</option>
              ))}
            </select>
          </Field>
          <Field label="URL">
            <ExpressionEditor ariaLabel="URL" rows={2} value={text("url")} paths={paths.map((entry) => entry.path)} onChange={(value) => onConfig("url", value)} onFocus={() => setExpressionTarget("url")} />
          </Field>
          <Field label="Headers" hint="JSON object">
            <ExpressionEditor ariaLabel="Headers" rows={4} value={text("headers")} paths={paths.map((entry) => entry.path)} onChange={(value) => onConfig("headers", value)} onFocus={() => setExpressionTarget("headers")} />
          </Field>
          <Field label="Body">
            <ExpressionEditor ariaLabel="Body" rows={7} value={text("body")} paths={paths.map((entry) => entry.path)} onChange={(value) => onConfig("body", value)} onFocus={() => setExpressionTarget("body")} />
          </Field>
        </>
      )}

      {node.data.kind === "data.compose" && (
        <Field label="Value" hint="Plain text or JSON; templates are resolved first.">
          <ExpressionEditor ariaLabel="Value" rows={12} value={text("value")} paths={paths.map((entry) => entry.path)} onChange={(value) => onConfig("value", value)} onFocus={() => setExpressionTarget("value")} />
        </Field>
      )}

      {node.data.kind === "logic.condition" && (
        <>
          <Field label="Left value">
            <ExpressionEditor ariaLabel="Left value" rows={2} value={text("left")} paths={paths.map((entry) => entry.path)} onChange={(value) => onConfig("left", value)} onFocus={() => setExpressionTarget("left")} />
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
            <ExpressionEditor ariaLabel="Right value" rows={2} value={text("right")} paths={paths.map((entry) => entry.path)} onChange={(value) => onConfig("right", value)} onFocus={() => setExpressionTarget("right")} />
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
            <small>Enable the flow and send the token as a Bearer token or X-9n9-Webhook-Token.</small>
            {shownWebhookToken && <code className="secret-once">{shownWebhookToken}</code>}
            {shownWebhookToken && <small>Copy now. This token is shown only once.</small>}
            <button className="button button--quiet" onClick={async () => { const token = await onRotateWebhook(); if (token) setShownWebhookToken(token); }}>Rotate token</button>
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

      <Field label="Node notes" hint="Internal documentation stored with this workflow.">
        <textarea aria-label="Node notes" rows={4} value={node.data.notes ?? ""} onChange={(event) => onNotes(event.target.value)} />
      </Field>

      {!node.data.kind.startsWith("annotation.") && (
        <section className="sample-data">
          <header><div><Braces size={14} /><strong>Pinned sample data</strong></div><span>saved with flow</span></header>
          <div className="sample-mode" role="group" aria-label="Sample environment">
            <button className={sampleMode === "development" ? "is-active" : ""} onClick={() => setSampleMode("development")}>Development</button>
            <button className={sampleMode === "production" ? "is-active" : ""} onClick={() => setSampleMode("production")}>Production</button>
          </div>
          <label>
            <span>{node.data.kind.startsWith("trigger.") ? "Workflow input sample" : "Node output sample"}</span>
            <textarea aria-label={`${sampleMode === "development" ? "Development" : "Production"} sample JSON`} rows={6} value={sampleDraft} onChange={(event) => setSampleDraft(event.target.value)} onBlur={commitSample} />
          </label>
          {sampleError && <p className="sample-error">{sampleError}</p>}
        </section>
      )}

      {availableFields.length > 0 && (
        <section className="expression-picker expression-workbench">
          <header><Braces size={14} /><strong>Expression workbench</strong></header>
          <div className="expression-source">
            <select aria-label="Expression data source" value={dataSource} onChange={(event) => setDataSource(event.target.value)}>
              <option value="pinned">Pinned {sampleMode} samples</option>
              {runs.map((run) => <option key={run.id} value={run.id}>Run · {formatTime(run.startedAt)} · {run.status}</option>)}
            </select>
            {selectedRun && <button className="button button--quiet" onClick={() => { onPinRun(selectedRun, sampleMode); setDataSource("pinned"); }}>Pin to {sampleMode}</button>}
          </div>
          <select aria-label="Expression target" value={activeExpressionTarget} onChange={(event) => setExpressionTarget(event.target.value)}>
            {availableFields.map((field) => <option key={field.key} value={field.key}>{field.label}</option>)}
          </select>
          <div className="transform-buttons" aria-label="Expression transforms">
            {["string", "number", "boolean", "date", "json", "array", "object"].map((name) => <button key={name} onClick={() => appendExpressionSyntax(` | ${name}`)}>{name}</button>)}
            <button onClick={() => appendExpressionSyntax(' ?? "fallback"')}>fallback</button>
            <button onClick={() => appendExpressionSyntax(' | jsonpath:"$.items[*].name"')}>JSONPath</button>
          </div>
          <label className="path-search"><Search size={12} /><input aria-label="Search sample paths" placeholder="Search input, steps, binary, files" value={pathQuery} onChange={(event) => setPathQuery(event.target.value)} /></label>
          <div className="data-paths">
            {paths.slice(0, 80).map((entry) => {
              const upstream = nodes.find((item) => entry.path === `steps.${item.id}`);
              const label = upstream ? `${upstream.data.label} output` : entry.path;
              return <button key={entry.path} onClick={() => insertExpression(`{{${entry.path}}}`)} title={`{{${entry.path}}}`}><span><Plus size={11} /> {label}</span><small>{entry.value === undefined ? "missing" : typeof entry.value === "string" ? entry.value : JSON.stringify(entry.value)}</small></button>;
            })}
            {!paths.length && <p>No matching sample paths.</p>}
          </div>
          <div className={`expression-preview${preview.diagnostics.some((item) => item.severity === "error") ? " has-error" : ""}`}>
            <header><strong>Preview</strong><span>{preview.expressions.length} expression{preview.expressions.length === 1 ? "" : "s"}</span></header>
            <pre>{JSON.stringify(preview.value, null, 2) ?? "undefined"}</pre>
            {preview.diagnostics.map((diagnostic, index) => <p key={`${diagnostic.code}-${index}`} className={`is-${diagnostic.severity}`}>{diagnostic.message}</p>)}
          </div>
        </section>
      )}

      {!node.data.kind.startsWith("annotation.") && <section className="node-test">
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
      </section>}

      {!node.data.kind.startsWith("annotation.") && (
        <div className="node-defaults">
          <button className="button button--quiet" onClick={onSaveDefault}>Use settings as default</button>
          {hasDefault && <button className="danger-link" onClick={onResetDefault}>Reset default</button>}
        </div>
      )}

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
