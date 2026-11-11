import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useApi } from "../lib/api-context.tsx";
import {
  businessObjectName,
  businessRelationName,
  businessTypeName,
  friendlyError,
  relationRiskVariant,
} from "../lib/format.ts";
import { cx } from "../lib/cx.ts";
import type {
  BusinessCategory,
  BusinessData,
  BusinessEdge,
  BusinessSelection,
  BusinessRelation,
} from "../lib/types.ts";
import {
  Badge,
  Button,
  Empty,
  Input,
  StatusText,
} from "../components/ui.tsx";
import { Drawer } from "../components/Drawer.tsx";
import { DetailRows, type DetailRow } from "../components/DetailRows.tsx";

const CATEGORIES: { id: BusinessCategory; label: string }[] = [
  { id: "objects", label: "对象" },
  { id: "relations", label: "关系" },
  { id: "actions", label: "动作" },
  { id: "terms", label: "术语" },
  { id: "types", label: "类型" },
];

const TYPE_COLORS = [
  "#2563eb",
  "#16a34a",
  "#db2777",
  "#f59e0b",
  "#7c3aed",
  "#0891b2",
  "#dc2626",
  "#4d7c0f",
  "#b45309",
  "#0f766e",
];

const STAT_CARDS: { id: BusinessCategory; label: string; hint: string; color: string }[] = [
  { id: "objects", label: "对象", hint: "实例", color: "#2563eb" },
  { id: "relations", label: "关系", hint: "定义", color: "#0891b2" },
  { id: "actions", label: "动作", hint: "可执行", color: "#16a34a" },
  { id: "terms", label: "术语", hint: "说法", color: "#db2777" },
  { id: "types", label: "类型", hint: "对象类", color: "#f59e0b" },
];

function StatIcon({ kind }: { kind: BusinessCategory }) {
  const icons: Record<BusinessCategory, ReactNode> = {
    objects: (
      <>
        <path d="m12 3.5 7.5 4v9L12 20.5l-7.5-4v-9l7.5-4Z" />
        <path d="m4.5 7.5 7.5 4 7.5-4M12 11.5v9" />
      </>
    ),
    relations: (
      <>
        <path d="m9.5 14.5 5-5" />
        <path d="m11 6.5 1.5-1.5a3.5 3.5 0 0 1 5 5L16 11.5" />
        <path d="m13 17.5-1.5 1.5a3.5 3.5 0 0 1-5-5L8 12.5" />
      </>
    ),
    actions: <path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12l1-8.5Z" />,
    terms: (
      <>
        <path d="M3.5 11.5v-7a1 1 0 0 1 1-1h7l9 9-8 8-9-9Z" />
        <circle cx="8" cy="8" r="1.4" />
      </>
    ),
    types: (
      <>
        <path d="m12 3 9 5-9 5-9-5 9-5Z" />
        <path d="m3 12 9 5 9-5M3 16l9 5 9-5" />
      </>
    ),
  };
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="h-[18px] w-[18px]"
    >
      {icons[kind]}
    </svg>
  );
}

interface BusinessItem {
  kind: BusinessCategory;
  id: string;
  title: string;
  subtitle: string;
}

function businessItemsFor(
  data: BusinessData,
  category: BusinessCategory,
  q: string,
): BusinessItem[] {
  const hit = (...vals: (string | undefined)[]) =>
    !q || vals.filter(Boolean).join(" ").toLowerCase().includes(q);

  if (category === "objects") {
    return data.objects
      .filter((o) =>
        hit(o.id, o.type, o.name, ...(o.aliases || []), o.description, ...(o.tags || [])),
      )
      .map((o) => ({
        kind: "objects",
        id: o.id,
        title: o.name || o.id,
        subtitle: `${businessTypeName(data, o.type)} · ${o.id}`,
      }));
  }
  if (category === "relations") {
    return data.relations
      .filter((r) => hit(r.id, r.name, r.fromType, r.toType, r.semantics))
      .map((r) => ({
        kind: "relations",
        id: r.id,
        title: `${businessTypeName(data, r.fromType)} → ${businessTypeName(data, r.toType)}`,
        subtitle: `${r.name || r.id} · ${r.edge_count ?? 0} 条边`,
      }));
  }
  if (category === "actions") {
    return data.actions
      .filter((a) =>
        hit(a.id, a.name, a.description, ...(a.appliesTo || []), ...(a.requiresRelations || [])),
      )
      .map((a) => ({
        kind: "actions",
        id: a.id,
        title: a.name || a.id,
        subtitle: `${(a.appliesTo || []).map((t) => businessTypeName(data, t)).join(" / ") || "未限定类型"}${a.risk ? ` · ${a.risk}` : ""}`,
      }));
  }
  if (category === "terms") {
    return data.terms
      .filter((t) => hit(t.term, t.objectId, t.note))
      .map((t) => ({
        kind: "terms",
        id: t.term,
        title: t.term,
        subtitle: `${t.objectId}${t.note ? ` · ${t.note}` : ""}`,
      }));
  }
  const typeCounts = new Map<string, number>();
  for (const o of data.objects) typeCounts.set(o.type, (typeCounts.get(o.type) || 0) + 1);
  return data.types
    .filter((t) => hit(t.id, t.name, t.description))
    .map((t) => ({
      kind: "types",
      id: t.id,
      title: t.name || t.id,
      subtitle: `${t.id} · ${typeCounts.get(t.id) || 0} 个对象`,
    }));
}

function categoryCount(data: BusinessData, id: BusinessCategory): number {
  if (id === "objects") return data.objects.length;
  if (id === "relations") return data.relations.length;
  if (id === "actions") return data.actions.length;
  if (id === "terms") return data.terms.length;
  return data.types.length;
}

function categoryLabel(id: BusinessCategory): string {
  return CATEGORIES.find((c) => c.id === id)?.label ?? id;
}

function BusinessLink({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      className="border-0 bg-transparent p-0 text-left wrap-anywhere text-accent hover:underline"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Subhead({ children }: { children: ReactNode }) {
  return <h4 className="mb-0.5 mt-4 text-[13px] font-semibold text-muted">{children}</h4>;
}

function EdgeRow({
  data,
  edge,
  selectedId,
  onSelect,
}: {
  data: BusinessData;
  edge: BusinessEdge;
  selectedId: string;
  onSelect: (kind: BusinessCategory, id: string) => void;
}) {
  const outgoing = edge.from === selectedId;
  const other = outgoing ? edge.to : edge.from;
  return (
    <div className="flex items-baseline gap-2 border-t border-dashed border-border py-1.5 text-[13px] wrap-anywhere first:border-t-0">
      <span className="flex-none text-muted">{outgoing ? "→" : "←"}</span>
      <span>{businessRelationName(data, edge.relation)}</span>
      <BusinessLink onClick={() => onSelect("objects", other)}>
        {businessObjectName(data, other)}
      </BusinessLink>
    </div>
  );
}

function BusinessDetail({
  data,
  selection,
  onSelect,
  onFocus,
}: {
  data: BusinessData | null;
  selection: BusinessSelection | null;
  onSelect: (kind: BusinessCategory, id: string) => void;
  onFocus?: (id: string) => void;
}) {
  if (!data || !data.exists) {
    return <p className="mx-auto my-8 max-w-[320px] text-center text-[13px] text-muted">还没有知识数据。</p>;
  }
  if (!selection) {
    return (
      <p className="mx-auto my-8 max-w-[320px] text-center text-[13px] text-muted">
        选一个条目看详情，或切到关系图点节点。
      </p>
    );
  }

  const typeName = (id: string) => businessTypeName(data, id);
  const objName = (id: string) => businessObjectName(data, id);
  const relName = (id: string) => businessRelationName(data, id);
  const rows = (list: DetailRow[]) => <DetailRows rows={list} />;
  const head = (title: string, badge?: ReactNode) => (
    <div className="flex items-start justify-between gap-2.5">
      <h3 className="m-0 text-[17px] font-semibold wrap-anywhere">{title}</h3>
      {badge}
    </div>
  );
  const body = (text?: string) =>
    text ? <div className="mt-2.5 whitespace-pre-wrap text-sm wrap-anywhere">{text}</div> : null;
  const linkLine = (label: string, onClick: () => void, extra?: ReactNode) => (
    <div className="flex items-baseline gap-2 border-t border-dashed border-border py-1.5 text-[13px] wrap-anywhere first:border-t-0">
      <BusinessLink onClick={onClick}>{label}</BusinessLink>
      {extra}
    </div>
  );

  if (selection.kind === "objects") {
    const o = data.objects.find((x) => x.id === selection.id);
    if (!o) return <p className="text-[13px] text-muted">对象 {selection.id} 不存在。</p>;
    const edges = data.edges.filter((e) => e.from === o.id || e.to === o.id);
    const actions = data.actions.filter((a) => (a.appliesTo || []).includes(o.type));
    const terms = data.terms.filter((t) => t.objectId === o.id);
    return (
      <>
        {head(o.name || o.id, <Badge variant="info">{typeName(o.type)}</Badge>)}
        {onFocus && (
          <div className="mt-2">
            <Button size="sm" variant="ghost" onClick={() => onFocus(o.id)}>
              在关系图中聚焦
            </Button>
          </div>
        )}
        {body(o.description)}
        {rows([
          { label: "id", value: o.id, mono: true },
          { label: "type", value: `${typeName(o.type)}（${o.type}）` },
          { label: "别名", value: (o.aliases || []).join(" / ") },
          {
            label: "key",
            value: o.key?.value ? `${o.key.kind ? `${o.key.kind}:` : ""}${o.key.value}` : "",
            mono: true,
          },
          {
            label: "source",
            value: o.source?.value
              ? `${o.source.kind ? `${o.source.kind}:` : ""}${o.source.value}`
              : "",
            mono: true,
          },
          { label: "tags", value: (o.tags || []).join(" / ") },
        ])}
        <Subhead>关系（{edges.length}）</Subhead>
        {!edges.length ? (
          <p className="text-sm text-muted">没有解析出边。</p>
        ) : (
          <div>
            {edges.map((e, i) => (
              <EdgeRow key={i} data={data} edge={e} selectedId={o.id} onSelect={onSelect} />
            ))}
          </div>
        )}
        {actions.length > 0 && (
          <>
            <Subhead>动作（{actions.length}）</Subhead>
            <div>
              {actions.map((a) =>
                linkLine(
                  a.name || a.id,
                  () => onSelect("actions", a.id),
                  a.risk ? <Badge>{a.risk}</Badge> : undefined,
                ),
              )}
            </div>
          </>
        )}
        {terms.length > 0 && (
          <>
            <Subhead>术语（{terms.length}）</Subhead>
            <div>
              {terms.map((t) => (
                <div
                  key={t.term}
                  className="flex items-baseline gap-2 border-t border-dashed border-border py-1.5 text-[13px] wrap-anywhere first:border-t-0"
                >
                  <span>{t.term}</span>
                  {t.note && <span className="text-muted">{t.note}</span>}
                </div>
              ))}
            </div>
          </>
        )}
      </>
    );
  }

  if (selection.kind === "relations") {
    const r = data.relations.find((x) => x.id === selection.id);
    if (!r) return <p className="text-[13px] text-muted">关系 {selection.id} 不存在。</p>;
    const edges = data.edges.filter((e) => e.relation === r.id);
    return (
      <>
        {head(
          `${typeName(r.fromType)} → ${typeName(r.toType)}`,
          r.risk ? <Badge variant={relationRiskVariant(r.risk)}>{r.risk}</Badge> : undefined,
        )}
        {body(r.semantics)}
        {rows([
          { label: "id", value: r.id, mono: true },
          { label: "name", value: r.name },
          { label: "from", value: `${typeName(r.fromType)}（${r.fromType}）` },
          { label: "to", value: `${typeName(r.toType)}（${r.toType}）` },
          { label: "cardinality", value: r.cardinality || "" },
          { label: "direction", value: r.direction || "" },
          {
            label: "mapping",
            value: r.mapping?.kind
              ? `${r.mapping.kind}${r.mapping.file ? ` · ${r.mapping.file}` : ""}`
              : "",
            mono: true,
          },
        ])}
        <Subhead>实际边（{edges.length}）</Subhead>
        {!edges.length ? (
          <p className="text-sm text-muted">没有边：这条关系还没写入对象实例。</p>
        ) : (
          <div>
            {edges.map((e, i) => (
              <div
                key={i}
                className="flex items-baseline gap-2 border-t border-dashed border-border py-1.5 text-[13px] wrap-anywhere first:border-t-0"
              >
                <BusinessLink onClick={() => onSelect("objects", e.from)}>
                  {objName(e.from)}
                </BusinessLink>
                <span className="text-muted">→</span>
                <BusinessLink onClick={() => onSelect("objects", e.to)}>
                  {objName(e.to)}
                </BusinessLink>
              </div>
            ))}
          </div>
        )}
      </>
    );
  }

  if (selection.kind === "actions") {
    const a = data.actions.find((x) => x.id === selection.id);
    if (!a) return <p className="text-[13px] text-muted">动作 {selection.id} 不存在。</p>;
    return (
      <>
        {head(
          a.name || a.id,
          a.risk ? <Badge variant={relationRiskVariant(a.risk)}>{a.risk}</Badge> : undefined,
        )}
        {body(a.description)}
        {rows([
          { label: "id", value: a.id, mono: true },
          {
            label: "appliesTo",
            value: (a.appliesTo || []).map((t) => typeName(t)).join(" / "),
          },
          {
            label: "requiresRelations",
            value: (a.requiresRelations || []).map((id) => `${relName(id)}（${id}）`).join(" / "),
          },
        ])}
      </>
    );
  }

  if (selection.kind === "terms") {
    const t = data.terms.find((x) => x.term === selection.id);
    if (!t) return <p className="text-[13px] text-muted">术语 {selection.id} 不存在。</p>;
    return (
      <>
        {head(t.term, <Badge variant="info">{objName(t.objectId)}</Badge>)}
        {body(t.note)}
        {rows([{ label: "objectId", value: t.objectId, mono: true }])}
        <div className="mt-2.5">
          <BusinessLink onClick={() => onSelect("objects", t.objectId)}>查看对象详情</BusinessLink>
        </div>
      </>
    );
  }

  const t = data.types.find((x) => x.id === selection.id);
  if (!t) return <p className="text-[13px] text-muted">类型 {selection.id} 不存在。</p>;
  const objects = data.objects.filter((o) => o.type === t.id);
  const relations = data.relations.filter((r) => r.fromType === t.id || r.toType === t.id);
  return (
    <>
      {head(t.name || t.id, <Badge variant="info">{objects.length} 个对象</Badge>)}
      {body(t.description)}
      {rows([
        { label: "id", value: t.id, mono: true },
        { label: "relations", value: String(relations.length) },
      ])}
      {objects.length > 0 && (
        <>
          <Subhead>对象（{objects.length}）</Subhead>
          <div>
            {objects.map((o) =>
              linkLine(o.name || o.id, () => onSelect("objects", o.id)),
            )}
          </div>
        </>
      )}
      {relations.length > 0 && (
        <>
          <Subhead>关系（{relations.length}）</Subhead>
          <div>
            {relations.map((r) =>
              linkLine(
                `${typeName(r.fromType)} → ${typeName(r.toType)}（${r.name || r.id}）`,
                () => onSelect("relations", r.id),
              ),
            )}
          </div>
        </>
      )}
    </>
  );
}

interface GraphNode {
  id: string;
  name: string;
  type: string;
  search: string;
  x: number;
  y: number;
}

interface BusinessNodeData extends Record<string, unknown> {
  label: string;
  typeLabel: string;
  color: string;
  dim: boolean;
  hot: boolean;
  near: boolean;
}

type BusinessFlowNode = Node<BusinessNodeData, "business">;

interface GraphFocusRequest {
  id: string;
  nonce: number;
}

function layoutGraph(
  nodes: GraphNode[],
  edges: BusinessEdge[],
  width: number,
  height: number,
): void {
  const n = nodes.length;
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) * 0.38;
  for (let i = 0; i < n; i++) {
    const angle = (Math.PI * 2 * i) / Math.max(1, n);
    nodes[i].x = cx + Math.cos(angle) * radius;
    nodes[i].y = cy + Math.sin(angle) * radius;
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const links = edges
    .map((e) => ({ a: byId.get(e.from), b: byId.get(e.to) }))
    .filter((l): l is { a: GraphNode; b: GraphNode } => !!l.a && !!l.b && l.a !== l.b);
  const ideal = 220;
  const minGap = 170;
  const separate = (strength: number) => {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = nodes[i];
        const b = nodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let dist = Math.hypot(dx, dy);
        if (dist < 0.01) {
          dx = ((i + 1) % 7) - 3 || 1;
          dy = ((j + 1) % 5) - 2 || 1;
          dist = Math.hypot(dx, dy) || 1;
        }
        if (dist < minGap) {
          dx /= dist;
          dy /= dist;
          const push = (minGap - dist) * strength;
          a.x -= dx * push;
          a.y -= dy * push;
          b.x += dx * push;
          b.y += dy * push;
        }
      }
    }
  };
  for (let iter = 0; iter < 260; iter++) {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = nodes[i];
        const b = nodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let dist = Math.hypot(dx, dy);
        if (dist < 0.01) {
          dx = ((i + 1) % 7) - 3 || 1;
          dy = ((j + 1) % 5) - 2 || 1;
          dist = Math.hypot(dx, dy) || 1;
        }
        const force = 18000 / (dist * dist);
        dx /= dist;
        dy /= dist;
        a.x -= dx * force;
        a.y -= dy * force;
        b.x += dx * force;
        b.y += dy * force;
        if (dist < minGap) {
          const push = (minGap - dist) * 0.5;
          a.x -= dx * push;
          a.y -= dy * push;
          b.x += dx * push;
          b.y += dy * push;
        }
      }
    }
    for (const link of links) {
      const dx = link.b.x - link.a.x;
      const dy = link.b.y - link.a.y;
      const dist = Math.hypot(dx, dy) || 1;
      const force = (dist - ideal) * 0.006;
      const ux = dx / dist;
      const uy = dy / dist;
      link.a.x += ux * force;
      link.a.y += uy * force;
      link.b.x -= ux * force;
      link.b.y -= uy * force;
    }
    for (const node of nodes) {
      node.x += (cx - node.x) * 0.002;
      node.y += (cy - node.y) * 0.002;
    }
  }
  for (let iter = 0; iter < 80; iter++) {
    separate(0.5);
    for (const node of nodes) {
      node.x += (cx - node.x) * 0.001;
      node.y += (cy - node.y) * 0.001;
    }
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    minX = Math.min(minX, node.x);
    maxX = Math.max(maxX, node.x);
    minY = Math.min(minY, node.y);
    maxY = Math.max(maxY, node.y);
  }
  const pad = 70;
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const scaleX = Math.min((width - pad * 2) / spanX, 2.2);
  const scaleY = Math.min((height - pad * 2) / spanY, 2.2);
  for (const node of nodes) {
    node.x = pad + (node.x - minX) * scaleX + (width - pad * 2 - spanX * scaleX) / 2;
    node.y = pad + (node.y - minY) * scaleY + (height - pad * 2 - spanY * scaleY) / 2;
  }
}

const NODE_SIZE = 96;
const NODE_RADIUS = NODE_SIZE / 2;
const ARROW_GAP = 12;

function BusinessNodeView({ data }: NodeProps<BusinessFlowNode>) {
  return (
    <div
      title={`${data.label}（${data.typeLabel}）`}
      className={cx(
        "relative flex h-full w-full items-center justify-center overflow-hidden rounded-full border-2 text-center text-white shadow-[var(--rb-shadow)] transition",
        data.hot
          ? "border-accent ring-4 ring-accent/30"
          : data.near
            ? "border-white/70"
            : "border-transparent",
        data.dim ? "opacity-25" : "opacity-100",
      )}
      style={{ backgroundColor: data.color }}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="rb-flow-handle"
        style={{ left: "50%", top: "50%" }}
      />
      <span className="line-clamp-2 px-2 text-[12px] font-semibold leading-[1.25] wrap-anywhere">
        {data.label}
      </span>
      <Handle
        type="source"
        position={Position.Top}
        className="rb-flow-handle"
        style={{ left: "50%", top: "50%" }}
      />
    </div>
  );
}

const NODE_TYPES = { business: BusinessNodeView };

function BusinessEdgeView({
  sourceX,
  sourceY,
  targetX,
  targetY,
  style,
  label,
  markerEnd,
}: EdgeProps) {
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return null;
  const ux = dx / dist;
  const uy = dy / dist;
  const shrink = Math.min(NODE_RADIUS + ARROW_GAP, dist * 0.8);
  const endX = targetX - ux * shrink;
  const endY = targetY - uy * shrink;
  const midX = (sourceX + endX) / 2;
  const midY = (sourceY + endY) / 2;
  return (
    <>
      <path
        d={`M ${sourceX},${sourceY} L ${endX},${endY}`}
        fill="none"
        style={style}
        markerEnd={markerEnd}
      />
      {label && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${midX}px, ${midY}px)`,
              pointerEvents: "none",
            }}
            className="rounded-[4px] border border-border/60 bg-surface/90 px-1 py-px text-[11px] leading-tight text-muted shadow-sm"
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const EDGE_TYPES = { business: BusinessEdgeView };

function BusinessGraphInner({
  data,
  typeColors,
  selection,
  query,
  focusRequest,
  onSelect,
  onClearSelection,
}: {
  data: BusinessData;
  typeColors: Map<string, string>;
  selection: BusinessSelection | null;
  query: string;
  focusRequest: GraphFocusRequest | null;
  onSelect: (kind: BusinessCategory, id: string) => void;
  onClearSelection: () => void;
}) {
  const { fitView, setCenter } = useReactFlow();
  const selectedId = selection?.kind === "objects" ? selection.id : null;

  const graph = useMemo(() => {
    const objects = data.objects.slice(0, 160);
    const byId = new Map(objects.map((o) => [o.id, o]));
    const edges = data.edges.filter((e) => byId.has(e.from) && byId.has(e.to));
    const nodes: GraphNode[] = objects.map((o) => ({
      id: o.id,
      name: o.name || o.id,
      type: o.type,
      search: [o.id, o.type, o.name, ...(o.aliases || []), ...(o.tags || [])]
        .join(" ")
        .toLowerCase(),
      x: 0,
      y: 0,
    }));
    const size = Math.max(1, nodes.length);
    const width = Math.min(3600, Math.max(1100, Math.sqrt(size * 96000)));
    const height = Math.max(620, width / 2);
    layoutGraph(nodes, edges, width, height);
    return { objects, edges, nodes, nodeById: new Map(nodes.map((n) => [n.id, n])) };
  }, [data]);

  const centerOn = useCallback(
    (id: string, zoom: number, duration: number) => {
      const node = graph.nodeById.get(id);
      if (!node) return;
      void setCenter(node.x + NODE_RADIUS, node.y + NODE_RADIUS, { zoom, duration });
    },
    [graph, setCenter],
  );

  const neighbors = useMemo(() => {
    const set = new Set<string>();
    if (!selectedId) return set;
    for (const edge of graph.edges) {
      if (edge.from === selectedId) set.add(edge.to);
      if (edge.to === selectedId) set.add(edge.from);
    }
    return set;
  }, [graph, selectedId]);

  const nodes = useMemo<BusinessFlowNode[]>(
    () =>
      graph.nodes.map((node) => ({
        id: node.id,
        type: "business",
        position: { x: node.x, y: node.y },
        width: NODE_SIZE,
        height: NODE_SIZE,
        ariaLabel: `${node.name}（${businessTypeName(data, node.type)}）`,
        data: {
          label: node.name,
          typeLabel: businessTypeName(data, node.type),
          color: typeColors.get(node.type) ?? TYPE_COLORS[0],
          dim: !!query && !node.search.includes(query) && selectedId !== node.id,
          hot: selectedId === node.id,
          near: neighbors.has(node.id),
        },
      })),
    [graph, data, typeColors, query, selectedId, neighbors],
  );

  const edges = useMemo<Edge[]>(
    () =>
      graph.edges.map((edge, index) => {
        const source = graph.nodeById.get(edge.from);
        const target = graph.nodeById.get(edge.to);
        const hot = !!selectedId && (edge.from === selectedId || edge.to === selectedId);
        const dim =
          !!query &&
          !hot &&
          !(source?.search.includes(query) || target?.search.includes(query));
        const color = hot
          ? "var(--rb-accent)"
          : "color-mix(in srgb, var(--rb-muted) 45%, transparent)";
        return {
          id: `${edge.from}->${edge.to}:${index}`,
          source: edge.from,
          target: edge.to,
          type: "business",
          selectable: false,
          focusable: false,
          interactionWidth: 0,
          markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18, color },
          style: {
            stroke: color,
            strokeWidth: hot ? 2 : 1.2,
            opacity: dim ? 0.12 : 1,
          },
          label:
            graph.edges.length <= 28 ? edge.relation_name || edge.relation : undefined,
        };
      }),
    [graph, selectedId, query],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (selectedId && graph.nodeById.has(selectedId)) {
        centerOn(selectedId, 0.9, 0);
      } else {
        void fitView({ padding: 0.16, duration: 0, minZoom: 0.8, maxZoom: 1.15 });
      }
    }, 60);
    return () => window.clearTimeout(timer);
  }, [graph, centerOn, fitView]);

  useEffect(() => {
    if (!focusRequest || !graph.nodeById.has(focusRequest.id)) return;
    const timer = window.setTimeout(() => {
      centerOn(focusRequest.id, 1.15, 450);
    }, 80);
    return () => window.clearTimeout(timer);
  }, [focusRequest, graph, centerOn]);

  if (!graph.objects.length) {
    return <Empty>没有可画的对象。</Empty>;
  }

  const focusSelected = () => {
    if (!selectedId) return;
    centerOn(selectedId, 1.15, 450);
  };

  return (
    <div className="rb-flow h-[clamp(460px,64vh,760px)] overflow-hidden bg-surface min-[1100px]:h-full">
      <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          minZoom={0.12}
          maxZoom={2.4}
          nodesDraggable={false}
          nodesConnectable={false}
          edgesFocusable={false}
          zoomOnDoubleClick={false}
          onInit={(instance) => {
            if (selectedId && graph.nodeById.has(selectedId)) {
              const node = graph.nodeById.get(selectedId)!;
              void instance.setCenter(node.x + NODE_RADIUS, node.y + NODE_RADIUS, {
                zoom: 0.9,
                duration: 0,
              });
            } else {
              void instance.fitView({ padding: 0.16, minZoom: 0.8, maxZoom: 1.15 });
            }
          }}
          onNodeClick={(_, node) => onSelect("objects", node.id)}
          onNodeDoubleClick={(_, node) => {
            centerOn(node.id, 1.15, 450);
          }}
          onPaneClick={onClearSelection}
          proOptions={{ hideAttribution: true }}
          className="bg-surface"
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
          <Controls showInteractive={false} position="bottom-left" />
          <MiniMap
            position="bottom-right"
            pannable
            zoomable
            ariaLabel="关系图导航小窗：拖动可平移画布"
            nodeColor={(node) => (node.data as BusinessNodeData).color}
            nodeStrokeWidth={0}
            maskStrokeColor="var(--rb-accent)"
            maskStrokeWidth={1.5}
          />
          <Panel position="top-right" className="!m-2 flex gap-1.5">
            <button
              type="button"
              className="rounded-full border border-border bg-surface/95 px-2.5 py-1 text-[11px] text-muted shadow-[var(--rb-shadow)] backdrop-blur transition hover:text-text"
              onClick={() => void fitView({ padding: 0.16, duration: 450, minZoom: 0.8, maxZoom: 1.15 })}
            >
              适应画布
            </button>
            <button
              type="button"
              disabled={!selectedId}
              className="rounded-full border border-border bg-surface/95 px-2.5 py-1 text-[11px] text-muted shadow-[var(--rb-shadow)] backdrop-blur transition hover:text-text disabled:opacity-45"
              onClick={focusSelected}
            >
              聚焦选中
            </button>
          </Panel>
        </ReactFlow>
    </div>
  );
}

function BusinessGraph(props: {
  data: BusinessData;
  typeColors: Map<string, string>;
  selection: BusinessSelection | null;
  query: string;
  focusRequest: GraphFocusRequest | null;
  onSelect: (kind: BusinessCategory, id: string) => void;
  onClearSelection: () => void;
}) {
  return (
    <ReactFlowProvider>
      <BusinessGraphInner {...props} />
    </ReactFlowProvider>
  );
}

export function BusinessPage({ reloadSignal }: { reloadSignal: number }) {
  const request = useApi();
  const [data, setData] = useState<BusinessData | null>(null);
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "" });
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<BusinessCategory>("objects");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<BusinessSelection | null>(null);
  const [focusRequest, setFocusRequest] = useState<GraphFocusRequest | null>(null);

  const load = useCallback(async () => {
    setStatus({ text: "加载中…" });
    try {
      const result = await request<BusinessData>("/v1/business");
      setData(result);
      setStatus({ text: result.exists ? "" : "还没有知识数据。" });
    } catch (e) {
      setData(null);
      setSelectedId(null);
      setDetail(null);
      setStatus({ text: `加载失败：${friendlyError(e)}`, error: true });
    }
  }, [request]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (reloadSignal === 0) return;
    void load();
  }, [reloadSignal, load]);

  const query = search.trim().toLowerCase();

  const typeColors = useMemo(() => {
    const map = new Map<string, string>();
    data?.types.forEach((type, index) => {
      map.set(type.id, TYPE_COLORS[index % TYPE_COLORS.length]);
    });
    return map;
  }, [data]);

  const relatedIds = useMemo(() => {
    if (!data || !selectedId) return null;
    const ids = new Set<string>([selectedId]);
    for (const edge of data.edges) {
      if (edge.from === selectedId) ids.add(edge.to);
      if (edge.to === selectedId) ids.add(edge.from);
    }
    return ids;
  }, [data, selectedId]);

  const items = useMemo(() => {
    if (!data) return [];
    const base = businessItemsFor(data, category, query);
    if (!relatedIds) return base;
    return base
      .filter((item) => item.kind === "objects" && relatedIds.has(item.id))
      .sort((a, b) => {
        if (a.id === selectedId) return -1;
        if (b.id === selectedId) return 1;
        return a.title.localeCompare(b.title, "zh-Hans-CN");
      });
  }, [data, category, query, relatedIds, selectedId]);

  const selectedObject = useMemo(
    () => (data && selectedId ? data.objects.find((o) => o.id === selectedId) : undefined),
    [data, selectedId],
  );

  const closeDetail = useCallback(() => setDetail(null), []);

  const openDetail = useCallback((kind: BusinessCategory, id: string) => {
    setDetail({ kind, id });
  }, []);

  const selectNode = useCallback((id: string) => {
    setCategory("objects");
    setSelectedId((prev) => (prev === id ? null : id));
  }, []);

  const clearSelection = useCallback(() => setSelectedId(null), []);

  const chooseCategory = (id: BusinessCategory) => {
    setSelectedId(null);
    setCategory(id);
  };

  const focusInGraph = useCallback((id: string) => {
    setDetail(null);
    setFocusRequest({ id, nonce: Date.now() });
  }, []);

  const graphTruncated = !!data && (data.edges_truncated || data.objects.length > 160);

  return (
    <div className="h-full overflow-y-auto px-[clamp(16px,4vw,44px)] pb-[60px] pt-[22px] max-[820px]:px-3.5 max-[820px]:pb-12 max-[820px]:pt-4">
      <StatusText text={status.text} error={status.error} />

      {!data ? null : !data.exists ? (
        <div className="grid place-items-center rounded-[14px] border border-border bg-surface px-6 py-16 text-center shadow-[var(--rb-shadow)]">
          <p className="m-0 max-w-[380px] text-[13px] leading-relaxed text-muted">
            还没有知识数据。由任务通过 `PUT /v1/business` 写入后再刷新。
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 min-[720px]:grid-cols-3 min-[1100px]:grid-cols-5">
            {STAT_CARDS.map((card) => {
              const active = category === card.id;
              return (
                <button
                  key={card.id}
                  type="button"
                  className={cx(
                    "group rounded-[14px] border bg-surface p-3.5 text-left shadow-[var(--rb-shadow)] transition hover:-translate-y-0.5 hover:border-accent/45",
                    active ? "border-accent ring-1 ring-accent/20" : "border-border",
                  )}
                  onClick={() => chooseCategory(card.id)}
                >
                  <div className="flex items-center gap-3">
                    <span
                      className="grid h-9 w-9 flex-none place-items-center rounded-[9px] text-white"
                      style={{ backgroundColor: card.color }}
                    >
                      <StatIcon kind={card.id} />
                    </span>
                    <div className="min-w-0">
                      <div className="truncate text-[11px] font-medium tracking-wide text-muted">
                        {card.label}
                      </div>
                      <div className="text-[22px] font-semibold leading-tight tabular-nums">
                        {categoryCount(data, card.id)}
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 flex items-center justify-between border-t border-border pt-2 text-[11px] text-muted transition group-hover:text-accent">
                    <span>{card.hint}</span>
                    <span aria-hidden="true">→</span>
                  </div>
                </button>
              );
            })}
          </div>

          <section className="mt-4 overflow-hidden rounded-[14px] border border-border bg-surface shadow-[var(--rb-shadow)]">
            <div className="grid items-stretch min-[1100px]:h-[clamp(520px,70vh,820px)] min-[1100px]:grid-cols-[minmax(0,1fr)_320px]">
              <aside className="order-1 flex max-h-[70vh] min-h-0 flex-col border-b border-border min-[1100px]:order-2 min-[1100px]:max-h-none min-[1100px]:border-b-0 min-[1100px]:border-l">
                <div className="flex-none border-b border-border p-2.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <h3 className="m-0 text-xs font-semibold">条目</h3>
                    <span className="text-[11px] text-muted tabular-nums">{items.length}</span>
                  </div>
                  {selectedId && selectedObject && (
                    <div className="mt-1.5 flex items-center gap-1.5 rounded-[7px] bg-accent-soft px-1.5 py-1 text-[11px] text-accent">
                      <span className="min-w-0 flex-1 truncate">
                        {`与「${selectedObject.name || selectedObject.id}」相关`}
                      </span>
                      <button
                        type="button"
                        className="flex-none underline-offset-2 hover:underline"
                        onClick={clearSelection}
                      >
                        清除
                      </button>
                    </div>
                  )}
                  <div className="mt-2 flex flex-wrap gap-1">
                    {CATEGORIES.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        className={cx(
                          "rounded-full border px-2 py-0.5 text-[11px] transition",
                          category === c.id
                            ? "border-accent bg-accent-soft text-accent"
                            : "border-border bg-surface text-muted hover:text-text",
                        )}
                        onClick={() => chooseCategory(c.id)}
                      >
                        {c.label} {categoryCount(data, c.id)}
                      </button>
                    ))}
                  </div>
                  <div className="mt-2">
                    <Input
                      type="search"
                      placeholder="搜索对象 / 关系 / 术语 / 类型"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </div>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
                  {!items.length ? (
                    <Empty>
                      {query
                        ? `没有匹配「${search.trim()}」的条目。`
                        : selectedId
                          ? "没有找到相关实体。"
                          : "这一分类还没有条目。"}
                    </Empty>
                  ) : (
                    <div className="grid gap-1.5">
                      {items.map((item) => {
                        const active =
                          (item.kind === "objects" && selectedId === item.id) ||
                          (detail?.kind === item.kind && detail?.id === item.id);
                        const objectType =
                          item.kind === "objects"
                            ? data.objects.find((o) => o.id === item.id)?.type
                            : undefined;
                        const dot =
                          (objectType && typeColors.get(objectType)) ||
                          STAT_CARDS.find((c) => c.id === item.kind)?.color ||
                          TYPE_COLORS[0];
                        return (
                          <button
                            key={`${item.kind}:${item.id}`}
                            type="button"
                            className={cx(
                              "w-full rounded-[10px] border px-2.5 py-2 text-left transition",
                              active
                                ? "border-accent bg-accent-soft"
                                : "border-border bg-surface hover:border-accent/45 hover:bg-surface2",
                            )}
                            onClick={() => openDetail(item.kind, item.id)}
                          >
                            <div className="flex items-center gap-2">
                              <span
                                className="h-2 w-2 flex-none rounded-full"
                                style={{ backgroundColor: dot }}
                              />
                              <span className="min-w-0 flex-1 text-[13px] font-semibold wrap-anywhere">
                                {item.title}
                              </span>
                            </div>
                            {item.subtitle && (
                              <div className="mt-0.5 pl-4 text-[11px] text-muted wrap-anywhere">
                                {item.subtitle}
                              </div>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </aside>

              <div className="order-2 flex min-w-0 flex-col min-[1100px]:order-1">
                <header className="flex flex-none flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
                  <div className="min-w-0">
                    <h2 className="m-0 text-sm font-semibold">知识图谱</h2>
                    <p className="m-0 mt-0.5 text-xs text-muted">
                      {`节点 = 对象，连线 = 关系，颜色 = 类型 · 点击节点高亮往来关系、右侧列出相关实体${graphTruncated ? " · 边已截断" : ""}`}
                    </p>
                  </div>
                  <span className="text-xs text-muted tabular-nums">
                    {`${data.objects.length} 个对象 · ${data.edge_total || data.edges.length} 条边 · 只读`}
                  </span>
                </header>
                <div className="min-h-0 flex-1">
                  <BusinessGraph
                    data={data}
                    typeColors={typeColors}
                    selection={selectedId ? { kind: "objects", id: selectedId } : null}
                    query={query}
                    focusRequest={focusRequest}
                    onSelect={(_kind, id) => selectNode(id)}
                    onClearSelection={clearSelection}
                  />
                </div>
              </div>
            </div>
          </section>
        </>
      )}

      {data?.exists && detail && (
        <Drawer title={`${categoryLabel(detail.kind)}详情`} onClose={closeDetail}>
          <BusinessDetail
            data={data}
            selection={detail}
            onSelect={openDetail}
            onFocus={focusInGraph}
          />
        </Drawer>
      )}
    </div>
  );
}
