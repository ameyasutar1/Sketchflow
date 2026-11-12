import {
  b64Vecs,
  createBindingId,
  type Editor,
  type TLShapeId,
  type TLDrawShape,
  toRichText,
} from "tldraw";
import { z } from "zod";
import { arrangeDiagram } from "./diagramLayout";

const coord = z.number().finite().min(-100_000).max(100_000);
const shapeId = z.string().regex(/^shape:[a-zA-Z0-9_-]{1,100}$/);
export const operationSchema = z
  .object({
    op: z.enum([
      "create_shape",
      "add_text",
      "draw_stroke",
      "create_arrow",
      "move_shape",
      "resize_shape",
      "update_text",
      "delete_shape",
    ]),
    id: shapeId,
    kind: z.enum(["rectangle", "ellipse", "diamond"]).default("rectangle"),
    x: coord.default(0),
    y: coord.default(0),
    w: z.number().finite().min(10).max(5000).default(180),
    h: z.number().finite().min(10).max(5000).default(100),
    text: z.string().max(2000).default(""),
    color: z
      .enum([
        "black",
        "grey",
        "blue",
        "light-blue",
        "green",
        "light-green",
        "red",
        "light-red",
        "orange",
        "yellow",
        "violet",
        "light-violet",
      ])
      .default("black"),
    points: z
      .array(z.object({ x: coord, y: coord }))
      .max(500)
      .default([]),
    from_id: shapeId.nullable().optional(),
    to_id: shapeId.nullable().optional(),
  })
  .strict();
export const batchSchema = z.object({
  type: z.literal("actions"),
  batch_id: z.string(),
  request_id: z.string(),
  revision: z.number().int().nonnegative(),
  page_id: z.string(),
  operations: z.array(operationSchema).min(1).max(40),
  explanation: z.string().max(500),
  requires_approval: z.boolean(),
});
export type Batch = z.infer<typeof batchSchema>;
export type Operation = z.infer<typeof operationSchema>;

/** User-invoked repair for existing diagrams; one undo step. */
export function tidyCanvasDiagram(editor: Editor) {
  const selected = editor.getSelectedShapeIds();
  const shapes = editor
    .getCurrentPageShapes()
    .filter(
      (s) =>
        (!selected.length || selected.includes(s.id)) &&
        !s.isLocked &&
        s.parentId === editor.getCurrentPageId() &&
        s.rotation === 0 &&
        (s.type === "geo" || s.type === "text"),
    );
  const mark = editor.markHistoryStoppingPoint("Tidy diagram");
  try {
    editor.run(() =>
      arrangeDiagram(
        editor,
        shapes.map((s) => s.id),
      ),
    );
    editor.markHistoryStoppingPoint();
    editor.zoomToFit();
  } catch (error) {
    editor.bailToMark(mark);
    throw error;
  }
}

/** Turn common model-produced LaTeX into readable plain text for the canvas. */
export function normalizeCanvasText(value: string): string {
  let text = value.replace(/\r\n?/g, "\n");
  for (let i = 0; i < 4; i++) {
    text = text
      .replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, "$1/$2")
      .replace(/\\sqrt\s*\{([^{}]*)\}/g, "√($1)")
      .replace(/\\text\s*\{([^{}]*)\}/g, "$1");
  }
  return text
    .replace(/\$+/g, "")
    .replace(/\\left|\\right/g, "")
    .replace(/\\cdot|\\times/g, "·")
    .replace(/\\leq|\\le/g, "≤")
    .replace(/\\geq|\\ge/g, "≥")
    .replace(/\\neq/g, "≠")
    .replace(/\\pm/g, "±")
    .replace(/\\infty/g, "∞")
    .replace(/\\(?:quad|qquad|,|;|!)/g, " ")
    .replace(/[{}]/g, "")
    .replace(/\\/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .trim();
}

function looksLikeSolution(value: string): boolean {
  const text = normalizeCanvasText(value);
  return (
    text.includes("\n") ||
    text.length > 110 ||
    /\b(?:solution|solve|step|answer|check|equation|therefore|roc)\b/i.test(
      text,
    )
  );
}

function richText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const node = value as { text?: string; content?: unknown[]; type?: string };
  return (
    (node.text || "") +
    (node.content?.map(richText).join(node.type === "doc" ? "\n" : "") || "")
  );
}

export function createCanvasBridge(editor: Editor) {
  let revision = 0;
  let signature = "";
  const applied = new Set<string>();
  function snapshot() {
    const shapes = editor.getCurrentPageShapes();
    const bindings = editor.store
      .allRecords()
      .filter((r) => r.typeName === "binding");
    const next = JSON.stringify([editor.getCurrentPageId(), shapes, bindings]);
    if (signature !== next) {
      signature = next;
      revision++;
    }
    const selected = new Set(editor.getSelectedShapeIds());
    return {
      revision,
      page_id: editor.getCurrentPageId(),
      total_shapes: shapes.length,
      selected_ids: [...selected],
      viewport: editor.getViewportPageBounds().toJson(),
      shapes: shapes
        .slice()
        .sort((a, b) => Number(selected.has(b.id)) - Number(selected.has(a.id)))
        .slice(0, 400)
        .map((s) => {
          const props = s.props as Record<string, unknown>;
          const bounds = editor.getShapePageBounds(s);
          return {
            id: s.id,
            type: s.type,
            kind: props.geo,
            x: bounds?.x ?? s.x,
            y: bounds?.y ?? s.y,
            w: bounds?.w,
            h: bounds?.h,
            parent_id: s.parentId,
            rotation: s.rotation,
            locked: s.isLocked,
            text: richText(props.richText).slice(0, 2000),
            color: props.color,
            points:
              s.type === "draw"
                ? (s as TLDrawShape).props.segments
                    .flatMap((seg) => b64Vecs.decodePoints(seg.path, seg.dim))
                    .filter((_, i) => i % 4 === 0)
                    .slice(0, 100)
                : undefined,
            connections: bindings
              .filter((b) => b.fromId === s.id)
              .map((b) => ({ to_id: b.toId, props: b.props })),
          };
        }),
    };
  }
  function apply(input: Batch) {
    const batch = batchSchema.parse(input);
    if (applied.has(batch.batch_id)) return;
    const current = snapshot();
    if (
      current.page_id !== batch.page_id ||
      current.revision !== batch.revision
    )
      throw new Error(
        "Canvas changed while planning. Read the canvas and retry.",
      );
    const mark = editor.markHistoryStoppingPoint("Agent: " + batch.explanation);
    try {
      const pageShapes = editor.getCurrentPageShapes();
      const pageBounds = pageShapes
        .map((shape) => editor.getShapePageBounds(shape))
        .filter((bounds): bounds is NonNullable<typeof bounds> =>
          Boolean(bounds),
        );
      const minX = pageBounds.length
        ? Math.min(...pageBounds.map((b) => b.x))
        : 80;
      let solutionY = pageBounds.length
        ? Math.max(...pageBounds.map((b) => b.y + b.h)) + 80
        : 80;
      editor.run(() => {
        for (const op of batch.operations) {
          const id = op.id as TLShapeId;
          const existing = editor.getShape(id);
          const creating = [
            "create_shape",
            "add_text",
            "draw_stroke",
            "create_arrow",
          ].includes(op.op);
          if (creating && existing) throw new Error("Shape ID already exists");
          if (
            !creating &&
            (!existing ||
              existing.isLocked ||
              existing.parentId !== editor.getCurrentPageId() ||
              existing.rotation !== 0)
          ) {
            throw new Error(
              "Target missing, locked, grouped, or rotated. Edit it manually.",
            );
          }
          switch (op.op) {
            case "create_shape":
              editor.createShape({
                id,
                type: "geo",
                meta: { agentRequest: batch.request_id },
                x: op.x,
                y: op.y,
                props: {
                  geo: op.kind,
                  w: op.text.trim()
                    ? Math.max(op.w, op.text.length > 100 ? 420 : 300)
                    : op.w,
                  h: op.text.trim() ? Math.max(op.h, 96) : op.h,
                  color: op.color,
                  font: "sans",
                  size: "m",
                  dash: "solid",
                  richText: toRichText(op.text),
                },
              });
              break;
            case "add_text":
              {
                const useSolutionLayout = looksLikeSolution(op.text);
                const useDefaultPosition =
                  useSolutionLayout && op.x === 0 && op.y === 0;
                const x = useDefaultPosition ? minX : op.x;
                const y = useDefaultPosition ? solutionY : op.y;
                editor.createShape({
                  id,
                  type: "text",
                  meta: { agentRequest: batch.request_id },
                  x,
                  y,
                  props: {
                    richText: toRichText(normalizeCanvasText(op.text)),
                    color: op.color,
                    size: "m",
                    font: "sans",
                    w: useSolutionLayout ? 760 : 300,
                    autoSize: false,
                  },
                });
                if (useSolutionLayout) {
                  const bounds = editor.getShapePageBounds(id);
                  solutionY = y + (bounds?.h ?? 40) + 40;
                }
              }
              break;
            case "draw_stroke": {
              if (op.points.length < 2)
                throw new Error("Stroke needs at least two points");
              const origin = op.points[0];
              editor.createShape({
                id,
                type: "draw",
                x: origin.x,
                y: origin.y,
                props: {
                  color: op.color,
                  size: "m",
                  isComplete: true,
                  isPen: false,
                  segments: [
                    {
                      type: "free",
                      dim: 2,
                      path: b64Vecs.encodePoints(
                        op.points.map((p) => ({
                          x: p.x - origin.x,
                          y: p.y - origin.y,
                        })),
                        2,
                      ),
                    },
                  ],
                },
              });
              break;
            }
            case "create_arrow": {
              if (!op.from_id || !op.to_id || op.from_id === op.to_id)
                throw new Error("Arrow needs distinct endpoints");
              const from = editor.getShapePageBounds(op.from_id as TLShapeId);
              const to = editor.getShapePageBounds(op.to_id as TLShapeId);
              if (!from || !to) throw new Error("Arrow endpoint missing");
              editor.createShape({
                id,
                type: "arrow",
                meta: { agentRequest: batch.request_id },
                x: from.center.x,
                y: from.center.y,
                props: {
                  kind: "elbow",
                  dash: "solid",
                  size: "s",
                  arrowheadEnd: "arrow",
                  start: { x: 0, y: 0 },
                  end: {
                    x: to.center.x - from.center.x,
                    y: to.center.y - from.center.y,
                  },
                  richText: toRichText(op.text),
                  color: op.color,
                },
              });
              editor.createBindings([
                {
                  id: createBindingId(),
                  type: "arrow",
                  fromId: id,
                  toId: op.from_id as TLShapeId,
                  props: {
                    terminal: "start",
                    normalizedAnchor: { x: 0.5, y: 0.5 },
                    isExact: false,
                    isPrecise: false,
                  },
                },
                {
                  id: createBindingId(),
                  type: "arrow",
                  fromId: id,
                  toId: op.to_id as TLShapeId,
                  props: {
                    terminal: "end",
                    normalizedAnchor: { x: 0.5, y: 0.5 },
                    isExact: false,
                    isPrecise: false,
                  },
                },
              ]);
              break;
            }
            case "move_shape":
              editor.updateShape({
                id,
                type: existing!.type,
                x: op.x,
                y: op.y,
              });
              break;
            case "resize_shape":
              if (existing!.type !== "geo")
                throw new Error(
                  "Only geometric shapes can be resized by the agent",
                );
              editor.updateShape({
                id,
                type: "geo",
                props: { w: op.w, h: op.h },
              });
              break;
            case "update_text":
              if (!["geo", "text", "arrow"].includes(existing!.type))
                throw new Error("This shape does not support editable text");
              editor.updateShape({
                id,
                type: existing!.type as "geo" | "text" | "arrow",
                props: { richText: toRichText(normalizeCanvasText(op.text)) },
              });
              break;
            case "delete_shape":
              if (existing!.type === "group")
                throw new Error(
                  "Ungroup shapes before deleting them with the agent",
                );
              editor.deleteShapes([id]);
              break;
          }
        }
        const seeds = new Set(batch.operations.map((op) => op.id as TLShapeId));
        for (const shape of editor.getCurrentPageShapes()) {
          if (shape.meta.agentRequest === batch.request_id) seeds.add(shape.id);
        }
        if (
          batch.operations.some((op) =>
            [
              "create_shape",
              "add_text",
              "create_arrow",
              "resize_shape",
              "update_text",
              "delete_shape",
            ].includes(op.op),
          )
        ) {
          arrangeDiagram(editor, [...seeds]);
        }
      });
      editor.markHistoryStoppingPoint();
      applied.add(batch.batch_id);
      snapshot();
    } catch (error) {
      editor.bailToMark(mark);
      snapshot();
      throw error;
    }
  }
  return { snapshot, apply };
}
export type CanvasBridge = ReturnType<typeof createCanvasBridge>;
