import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Editor,
  createTLStore,
  defaultShapeUtils,
  defaultBindingUtils,
  defaultTools,
  defaultShapeTools,
  tipTapDefaultExtensions,
  defaultAddFontsFromNode,
  b64Vecs,
  type TLDrawShape,
  type TLShapeId,
} from "tldraw";
import {
  batchSchema,
  createCanvasBridge,
  normalizeCanvasText,
  tidyCanvasDiagram,
  operationSchema,
  type Batch,
} from "./canvas";
import { diagramEdges, routeHits } from "./diagramLayout";

let editor: Editor;
let bridge: ReturnType<typeof createCanvasBridge>;
const id = "shape:one" as TLShapeId;
beforeEach(() => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  editor = new Editor({
    store: createTLStore({
      shapeUtils: defaultShapeUtils,
      bindingUtils: defaultBindingUtils,
    }),
    shapeUtils: defaultShapeUtils,
    bindingUtils: defaultBindingUtils,
    tools: [...defaultTools, ...defaultShapeTools],
    getContainer: () => container,
    initialState: "select",
    textOptions: {
      tipTapConfig: { extensions: tipTapDefaultExtensions },
      addFontsFromNode: defaultAddFontsFromNode,
    },
  });
  bridge = createCanvasBridge(editor);
});
afterEach(() => {
  editor?.dispose();
  document.body.innerHTML = "";
});
function batch(operations: unknown[], batch_id = crypto.randomUUID()): Batch {
  const state = bridge.snapshot();
  return batchSchema.parse({
    type: "actions",
    batch_id,
    request_id: "test",
    revision: state.revision,
    page_id: state.page_id,
    operations,
    explanation: "Test edits",
    requires_approval: false,
  });
}
describe("actual tldraw canvas executor", () => {
  it("reflows a branched diagram across batches, keeps notes below, and routes skip edges around nodes", () => {
    const ids = ["shape:a", "shape:b", "shape:c", "shape:d"] as TLShapeId[];
    bridge.apply(
      batch(
        ids.map((id) => ({
          op: "create_shape",
          id,
          text: "A label that wraps to multiple lines",
          x: 0,
          y: 0,
        })),
      ),
    );
    bridge.apply(
      batch([
        { op: "create_arrow", id: "shape:ab", from_id: ids[0], to_id: ids[1] },
        { op: "create_arrow", id: "shape:bc", from_id: ids[1], to_id: ids[2] },
        { op: "create_arrow", id: "shape:cd", from_id: ids[2], to_id: ids[3] },
        { op: "create_arrow", id: "shape:ad", from_id: ids[0], to_id: ids[3] },
        {
          op: "add_text",
          id: "shape:explanation",
          text: "Explanation: this diagram includes a skip connection.",
        },
      ]),
    );
    const previous = editor.getShapePageBounds(ids[3])!;
    const followup = batch([
      { op: "create_shape", id: "shape:next", text: "New processing layer" },
      {
        op: "create_arrow",
        id: "shape:dn",
        from_id: ids[3],
        to_id: "shape:next",
      },
    ]);
    followup.request_id = "followup";
    bridge.apply(followup);
    const last = editor.getShapePageBounds("shape:next" as TLShapeId)!;
    const note = editor.getShapePageBounds("shape:explanation" as TLShapeId)!;
    expect(last.y).toBeGreaterThan(previous.y);
    expect(note.y).toBeGreaterThan(last.y + last.h);
    const nodes = editor
      .getCurrentPageShapes()
      .filter((s) => s.type !== "arrow");
    for (const edge of diagramEdges(editor)) {
      const obstacles = nodes
        .filter((s) => s.id !== edge.from && s.id !== edge.to)
        .map((s) => editor.getShapePageBounds(s)!);
      expect(routeHits(editor, edge, obstacles)).toBe(0);
    }
    for (let i = 0; i < nodes.length; i++)
      for (let j = i + 1; j < nodes.length; j++) {
        const a = editor.getShapePageBounds(nodes[i])!,
          b = editor.getShapePageBounds(nodes[j])!;
        expect(
          a.x < b.x + b.w &&
            a.x + a.w > b.x &&
            a.y < b.y + b.h &&
            a.y + a.h > b.y,
        ).toBe(false);
      }
  });
  it("separates intersecting boxes using their rendered bounds and keeps bindings", () => {
    bridge.apply(
      batch([
        {
          op: "create_shape",
          id,
          text: "Input embedding and positional encoding",
          w: 260,
          h: 100,
        },
        {
          op: "create_shape",
          id: "shape:two",
          y: 40,
          w: 260,
          h: 100,
          text: "Multi-head attention",
        },
        {
          op: "create_arrow",
          id: "shape:link",
          from_id: id,
          to_id: "shape:two",
        },
      ]),
    );
    const a = editor.getShapePageBounds(id)!;
    const b = editor.getShapePageBounds("shape:two" as TLShapeId)!;
    expect(b.y).toBeGreaterThanOrEqual(a.y + a.h + 40);
    expect(
      editor.getBindingsFromShape("shape:link" as TLShapeId, "arrow"),
    ).toHaveLength(2);
    editor.undo();
    expect(editor.getCurrentPageShapes()).toHaveLength(0);
  });
  it("keeps wrapped paragraphs as single text shapes and separates subsequent text", () => {
    bridge.apply(
      batch([
        {
          op: "add_text",
          id,
          text:
            "Attention: " + "A longer explanation of attention. ".repeat(15),
        },
        { op: "add_text", id: "shape:two", text: "Solution: next paragraph" },
      ]),
    );
    expect(editor.getCurrentPageShapes()).toHaveLength(2);
    const a = editor.getShapePageBounds(id)!;
    const b = editor.getShapePageBounds("shape:two" as TLShapeId)!;
    expect(b.y).toBeGreaterThanOrEqual(a.y + a.h + 40);
  });
  it("repairs existing overlaps in one undo step", () => {
    editor.createShapes([
      { id, type: "geo" },
      { id: "shape:two" as TLShapeId, type: "geo", y: 10 },
    ]);
    tidyCanvasDiagram(editor);
    const a = editor.getShapePageBounds(id)!;
    expect(
      editor.getShapePageBounds("shape:two" as TLShapeId)!.x,
    ).toBeGreaterThanOrEqual(a.x + a.w + 40);
    editor.undo();
    expect(editor.getShape("shape:two" as TLShapeId)!.y).toBe(10);
  });
  it("normalizes model math markup before rendering", () => {
    expect(normalizeCanvasText("$x = \\frac{14}{2} \\cdot 1$")).toBe(
      "x = 14/2 · 1",
    );
    expect(normalizeCanvasText("\\text{Answer: } x \\leq 7")).toBe(
      "Answer: x ≤ 7",
    );
  });

  it("creates an editable freehand stroke and undoes it", () => {
    bridge.apply(
      batch([
        {
          op: "draw_stroke",
          id,
          points: [
            { x: 10, y: 20 },
            { x: 50, y: 0 },
            { x: 100, y: 30 },
          ],
        },
      ]),
    );
    const shape = editor.getShape(id) as TLDrawShape;
    expect(shape.type).toBe("draw");
    expect(b64Vecs.decodePoints(shape.props.segments[0].path, 2)).toHaveLength(
      3,
    );
    editor.undo();
    expect(editor.getShape(id)).toBeUndefined();
  });
  it("rejects stale edits without modifying the board", () => {
    const stale = batch([{ op: "create_shape", id }]);
    editor.createShape({ id: "shape:human" as TLShapeId, type: "geo" });
    expect(() => bridge.apply(stale)).toThrow(/changed/);
    expect(editor.getShape(id)).toBeUndefined();
    expect(editor.getCurrentPageShapes()).toHaveLength(1);
  });
  it("rolls back the whole batch on failure", () => {
    expect(() =>
      bridge.apply(
        batch([
          { op: "create_shape", id },
          { op: "delete_shape", id: "shape:missing" },
        ]),
      ),
    ).toThrow();
    expect(editor.getCurrentPageShapes()).toHaveLength(0);
  });
  it("deduplicates replayed batches", () => {
    const action = batch([{ op: "create_shape", id }]);
    bridge.apply(action);
    bridge.apply(action);
    expect(editor.getCurrentPageShapes()).toHaveLength(1);
  });
  it("binds arrows to endpoints and keeps them editable", () => {
    bridge.apply(
      batch([
        { op: "create_shape", id },
        { op: "create_shape", id: "shape:two", x: 300 },
        {
          op: "create_arrow",
          id: "shape:arrow",
          from_id: id,
          to_id: "shape:two",
        },
      ]),
    );
    expect(
      editor.getBindingsFromShape("shape:arrow" as TLShapeId, "arrow"),
    ).toHaveLength(2);
    bridge.apply(batch([{ op: "move_shape", id, x: 70, y: 100 }]));
    expect(editor.getShape(id)?.x).toBe(70);
  });
  it("rejects unknown actions and oversized strokes", () => {
    expect(() => operationSchema.parse({ op: "execute", id })).toThrow();
    expect(() =>
      operationSchema.parse({
        op: "draw_stroke",
        id,
        points: Array(501).fill({ x: 0, y: 0 }),
      }),
    ).toThrow();
  });
});
