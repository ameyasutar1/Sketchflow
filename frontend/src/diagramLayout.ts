import dagre from "@dagrejs/dagre";
import {
  getArrowInfo,
  type Editor,
  type TLShapeId,
  type TLArrowShape,
  type TLArrowBinding,
} from "tldraw";

type Rect = { x: number; y: number; w: number; h: number };
type Edge = {
  id: TLShapeId;
  from: TLShapeId;
  to: TLShapeId;
  bindings: TLArrowBinding[];
};
const GAP = 64;

export function textContent(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const node = value as { text?: string; content?: unknown[] };
  return node.text ?? node.content?.map(textContent).join(" ") ?? "";
}

function intersects(a: Rect, b: Rect, gap = GAP) {
  return (
    a.x < b.x + b.w + gap &&
    a.x + a.w + gap > b.x &&
    a.y < b.y + b.h + gap &&
    a.y + a.h + gap > b.y
  );
}

export function diagramEdges(editor: Editor): Edge[] {
  return editor
    .getCurrentPageShapes()
    .filter((s) => s.type === "arrow")
    .flatMap((s) => {
      const bindings = editor.getBindingsFromShape<TLArrowBinding>(
        s.id,
        "arrow",
      );
      const from = bindings.find((b) => b.props.terminal === "start")?.toId;
      const to = bindings.find((b) => b.props.terminal === "end")?.toId;
      return from && to ? [{ id: s.id, from, to, bindings }] : [];
    });
}

/** Check orthogonal connector segments against the interiors of other nodes. */
export function routeHits(editor: Editor, edge: Edge, obstacles: Rect[]) {
  const info = getArrowInfo(editor, edge.id);
  if (!info || info.type !== "elbow") return Infinity;
  const transform = editor.getShapePageTransform(edge.id);
  const points = info.route.points.map((p) => transform.applyToPoint(p));
  let hits = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i];
    for (const r of obstacles) {
      // Endpoints sit on borders; only entering a node's interior is a hit.
      if (
        Math.abs(a.x - b.x) < 0.1 &&
        a.x > r.x + 1 &&
        a.x < r.x + r.w - 1 &&
        Math.max(a.y, b.y) > r.y + 1 &&
        Math.min(a.y, b.y) < r.y + r.h - 1
      )
        hits++;
      if (
        Math.abs(a.y - b.y) < 0.1 &&
        a.y > r.y + 1 &&
        a.y < r.y + r.h - 1 &&
        Math.max(a.x, b.x) > r.x + 1 &&
        Math.min(a.x, b.x) < r.x + r.w - 1
      )
        hits++;
    }
  }
  return hits;
}

function routeEdge(editor: Editor, edge: Edge) {
  const arrow = editor.getShape<TLArrowShape>(edge.id);
  if (
    !arrow ||
    arrow.isLocked ||
    arrow.parentId !== editor.getCurrentPageId() ||
    arrow.rotation
  )
    return;
  const obstacles = editor
    .getCurrentPageShapes()
    .filter((s) => s.type !== "arrow" && s.id !== edge.from && s.id !== edge.to)
    .map((s) => editor.getShapePageBounds(s))
    .filter((r): r is NonNullable<typeof r> => Boolean(r));
  const pairs = [
    [
      { x: 0.5, y: 1 },
      { x: 0.5, y: 0 },
    ],
    [
      { x: 1, y: 0.5 },
      { x: 0, y: 0.5 },
    ],
    [
      { x: 0, y: 0.5 },
      { x: 1, y: 0.5 },
    ],
    [
      { x: 1, y: 0.5 },
      { x: 1, y: 0.5 },
    ],
    [
      { x: 0, y: 0.5 },
      { x: 0, y: 0.5 },
    ],
    [
      { x: 0.5, y: 0 },
      { x: 0.5, y: 1 },
    ],
  ];
  let best = { hits: Infinity, pair: pairs[0], midpoint: 0.5 };
  for (const pair of pairs) {
    editor.updateBindings(
      edge.bindings.map((b) => ({
        id: b.id,
        type: "arrow" as const,
        props: {
          normalizedAnchor: pair[b.props.terminal === "start" ? 0 : 1],
          isPrecise: true,
          isExact: false,
        },
      })),
    );
    for (const midpoint of [0.5, 0.2, 0.8, -1, 2]) {
      editor.updateShape({
        id: edge.id,
        type: "arrow",
        props: {
          kind: "elbow",
          elbowMidPoint: midpoint,
          arrowheadStart: "none",
          arrowheadEnd: "arrow",
          size: "s",
          dash: "solid",
        },
      });
      const hits = routeHits(editor, edge, obstacles);
      if (hits < best.hits) best = { hits, pair, midpoint };
      if (!hits) return;
    }
  }
  editor.updateBindings(
    edge.bindings.map((b) => ({
      id: b.id,
      type: "arrow" as const,
      props: {
        normalizedAnchor: best.pair[b.props.terminal === "start" ? 0 : 1],
        isPrecise: true,
        isExact: false,
      },
    })),
  );
  editor.updateShape({
    id: edge.id,
    type: "arrow",
    props: { elbowMidPoint: best.midpoint },
  });
  if (best.hits)
    throw new Error(
      "Could not route a connector without crossing a box. Simplify the connections and retry.",
    );
}

/** Reflow whole affected connected components, then their explanatory notes. */
export function arrangeDiagram(editor: Editor, seeds: TLShapeId[]) {
  const eligible = editor
    .getCurrentPageShapes()
    .filter(
      (s) =>
        (s.type === "geo" || s.type === "text") &&
        !s.isLocked &&
        !s.rotation &&
        s.parentId === editor.getCurrentPageId(),
    );
  const byId = new Map(eligible.map((s) => [s.id, s]));
  const edges = diagramEdges(editor);
  const adjacency = new Map<TLShapeId, Set<TLShapeId>>();
  for (const edge of edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    for (const [a, b] of [
      [edge.from, edge.to],
      [edge.to, edge.from],
    ]) {
      if (!adjacency.has(a)) adjacency.set(a, new Set());
      adjacency.get(a)!.add(b);
    }
  }
  const wanted = new Set(seeds);
  for (const edge of edges)
    if (wanted.has(edge.id)) {
      wanted.add(edge.from);
      wanted.add(edge.to);
    }
  // A follow-up explanation may be the only new shape in this request. Include
  // its target diagram before finding components, even if no new arrow is added.
  for (const id of seeds) {
    const shape = byId.get(id);
    if (!shape || adjacency.has(id)) continue;
    const label = textContent((shape.props as { richText?: unknown }).richText);
    if (shape.type !== "text" && label.length < 160) continue;
    const anchor = shape.meta.diagramNode as TLShapeId | undefined;
    const nearest =
      anchor && byId.has(anchor)
        ? byId.get(anchor)
        : eligible
            .filter((s) => adjacency.has(s.id))
            .sort(
              (a, b) =>
                Math.hypot(a.x - shape.x, a.y - shape.y) -
                Math.hypot(b.x - shape.x, b.y - shape.y),
            )[0];
    if (nearest) wanted.add(nearest.id);
  }
  const seen = new Set<TLShapeId>();
  const components: TLShapeId[][] = [];
  for (const seed of wanted) {
    if (!byId.has(seed) || seen.has(seed)) continue;
    const component: TLShapeId[] = [],
      queue = [seed];
    while (queue.length) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      component.push(id);
      queue.push(...(adjacency.get(id) ?? []));
    }
    components.push(component);
  }
  // Associate unconnected explanations with their nearest diagram, preserving this
  // association across later batches so inserted layers push notes down as a unit.
  const connected = components.filter((c) => c.length > 1);
  const notes = new Map<TLShapeId[], TLShapeId[]>();
  for (const shape of eligible) {
    if (adjacency.has(shape.id)) continue;
    const label = textContent((shape.props as { richText?: unknown }).richText);
    if (shape.type !== "text" && label.length < 160) continue;
    const anchor = shape.meta.diagramNode as TLShapeId | undefined;
    let group = connected.find((c) => anchor && c.includes(anchor));
    if (!group && wanted.has(shape.id) && connected.length) {
      group = connected.slice().sort((a, b) => {
        const distance = (c: TLShapeId[]) =>
          Math.min(
            ...c.map((id) => {
              const s = byId.get(id)!;
              return Math.hypot(s.x - shape.x, s.y - shape.y);
            }),
          );
        return distance(a) - distance(b);
      })[0];
    }
    if (group) {
      if (!notes.has(group)) notes.set(group, []);
      notes.get(group)!.push(shape.id);
      seen.add(shape.id);
      editor.updateShape({
        id: shape.id,
        type: shape.type,
        meta: { ...shape.meta, diagramNode: group[0] },
      });
    }
  }
  const noteIds = new Set([...notes.values()].flat());
  const occupied: Rect[] = editor
    .getCurrentPageShapes()
    .filter((s) => !seen.has(s.id) && s.type !== "arrow")
    .map((s) => editor.getShapePageBounds(s))
    .filter((r): r is NonNullable<typeof r> => Boolean(r));
  components.sort((a, b) => byId.get(a[0])!.x - byId.get(b[0])!.x);
  for (const component of components) {
    if (component.every((id) => noteIds.has(id))) continue;
    const rects = component.map((id) => editor.getShapePageBounds(id)!);
    let originX = Math.min(...rects.map((r) => r.x)),
      originY = Math.min(...rects.map((r) => r.y));
    const positions = new Map<TLShapeId, Rect>();
    if (component.length > 1) {
      const graph = new dagre.graphlib.Graph({ multigraph: true });
      graph.setGraph({
        rankdir: "TB",
        nodesep: 100,
        ranksep: 100,
        edgesep: 40,
      });
      graph.setDefaultEdgeLabel(() => ({}));
      for (const id of component) {
        const shape = editor.getShape(id)!;
        const label = textContent(
          (shape.props as { richText?: unknown }).richText,
        );
        if (shape.type === "geo" && label.trim())
          editor.updateShape({
            id,
            type: "geo",
            props: {
              w: label.length > 100 ? 420 : 300,
              h: 96,
              font: "sans",
              size: "m",
              dash: "solid",
            },
          });
        if (shape.type === "text")
          editor.updateShape({
            id,
            type: "text",
            props: { w: 300, autoSize: false, font: "sans", size: "m" },
          });
        const r = editor.getShapePageBounds(id)!;
        graph.setNode(id, { width: r.w, height: r.h });
      }
      for (const edge of edges)
        if (component.includes(edge.from) && component.includes(edge.to)) {
          graph.setEdge(edge.from, edge.to, {}, edge.id);
        }
      dagre.layout(graph);
      for (const id of component) {
        const n = graph.node(id);
        positions.set(id, {
          x: n.x - n.width / 2,
          y: n.y - n.height / 2,
          w: n.width,
          h: n.height,
        });
      }
    } else
      positions.set(component[0], { x: 0, y: 0, w: rects[0].w, h: rects[0].h });
    let width = Math.max(...[...positions.values()].map((r) => r.x + r.w));
    let height = Math.max(...[...positions.values()].map((r) => r.y + r.h));
    for (const id of notes.get(component) ?? []) {
      const shape = editor.getShape(id)!;
      editor.updateShape({
        id,
        type: shape.type as "geo" | "text",
        props: {
          w: Math.max(420, Math.min(width, 760)),
          font: "sans",
          size: "m",
        },
      });
      const r = editor.getShapePageBounds(id)!;
      positions.set(id, { x: 0, y: height + 100, w: r.w, h: r.h });
      width = Math.max(width, r.w);
      height += 100 + r.h;
    }
    // Move the entire component past unrelated work, never individual ranks.
    for (let i = 0; i <= occupied.length; i++) {
      const collisions = occupied.filter((r) =>
        intersects({ x: originX, y: originY, w: width, h: height }, r),
      );
      if (!collisions.length) break;
      originX = Math.max(...collisions.map((r) => r.x + r.w)) + 100;
    }
    for (const [id, r] of positions) {
      const shape = editor.getShape(id)!;
      editor.updateShape({
        id,
        type: shape.type,
        x: originX + r.x,
        y: originY + r.y,
      });
    }
    occupied.push({ x: originX, y: originY, w: width, h: height });
  }
  for (const edge of edges)
    if (seen.has(edge.from) || seen.has(edge.to)) routeEdge(editor, edge);
}
