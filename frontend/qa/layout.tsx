import React from "react";
import { createRoot } from "react-dom/client";
import { Tldraw, type Editor, type TLShapeId } from "tldraw";
import { getAssetUrlsByImport } from "@tldraw/assets/imports.vite";
import { batchSchema, createCanvasBridge } from "../src/canvas";
import { diagramEdges, routeHits } from "../src/diagramLayout";
import "tldraw/tldraw.css";

const labels = [
  "Input tokens",
  "Input embedding + positional encoding",
  "Multi-head self-attention",
  "Add & Norm",
  "Feed-forward network",
  "Add & Norm",
  "Shifted target tokens",
  "Output embedding + positional encoding",
  "Masked multi-head self-attention",
  "Add & Norm",
  "Encoder–decoder cross-attention",
  "Add & Norm",
  "Feed-forward network",
  "Add & Norm",
  "Linear + Softmax",
  "Output token",
];
const links = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  [4, 5],
  [6, 7],
  [7, 8],
  [8, 9],
  [9, 10],
  [5, 10],
  [10, 11],
  [11, 12],
  [12, 13],
  [13, 14],
  [14, 15],
  [1, 3],
  [3, 5],
  [7, 9],
  [9, 11],
  [11, 13],
];
async function run(editor: Editor) {
  try {
    await document.fonts.load('24px "tldraw_sans"');
    const bridge = createCanvasBridge(editor);
    const apply = (
      operations: unknown[],
      index: number,
      requestId = "fixture",
    ) => {
      const state = bridge.snapshot();
      bridge.apply(
        batchSchema.parse({
          type: "actions",
          batch_id: `fixture-${index}`,
          request_id: requestId,
          revision: state.revision,
          page_id: state.page_id,
          operations,
          explanation: "Layout regression",
          requires_approval: false,
        }),
      );
    };
    // Deliberately overlapping coordinates and small boxes, as in model output.
    apply(
      labels.map((text, i) => ({
        op: "create_shape",
        id: `shape:n${i}`,
        x: i < 6 ? 40 : 100,
        y: i * 12,
        w: 100,
        h: 20,
        text,
      })),
      0,
    );
    apply(
      links.map(([from, to], i) => ({
        op: "create_arrow",
        id: `shape:e${i}`,
        from_id: `shape:n${from}`,
        to_id: `shape:n${to}`,
      })),
      1,
    );
    apply(
      [
        {
          op: "add_text",
          id: "shape:note",
          text: "Attention compares queries with keys, normalizes scores with softmax, and combines values using the resulting weights. Multiple heads learn different relationships. Masked attention excludes future tokens; cross-attention reads encoder output.",
        },
      ],
      2,
      "explain-followup",
    );
    apply(
      [
        { op: "delete_shape", id: "shape:e14" },
        {
          op: "create_shape",
          id: "shape:sample",
          text: "Select next token",
          x: 100,
          y: 150,
        },
        {
          op: "create_arrow",
          id: "shape:sample-in",
          from_id: "shape:n14",
          to_id: "shape:sample",
        },
        {
          op: "create_arrow",
          id: "shape:sample-out",
          from_id: "shape:sample",
          to_id: "shape:n15",
        },
      ],
      3,
      "expand-followup",
    );
    await document.fonts.ready;
    editor.zoomToFit({ animation: { duration: 0 } });
    const shapes = editor
      .getCurrentPageShapes()
      .filter((s) => s.type !== "arrow");
    const bounds = shapes.map((s) => ({
      id: s.id,
      ...editor.getShapePageBounds(s)!.toJson(),
    }));
    const overlaps: string[] = [];
    for (let i = 0; i < bounds.length; i++)
      for (let j = i + 1; j < bounds.length; j++) {
        const a = bounds[i],
          b = bounds[j];
        if (
          a.x < b.x + b.w &&
          a.x + a.w > b.x &&
          a.y < b.y + b.h &&
          a.y + a.h > b.y
        )
          overlaps.push(`${a.id}/${b.id}`);
      }
    const crossings = diagramEdges(editor)
      .filter(
        (edge) =>
          routeHits(
            editor,
            edge,
            bounds.filter((b) => b.id !== edge.from && b.id !== edge.to),
          ) > 0,
      )
      .map((e) => e.id);
    (window as any).layoutResult = {
      overlaps,
      crossings,
      shapeCount: shapes.length,
      arrowCount: diagramEdges(editor).length,
    };
    (window as any).layoutEditor = editor;
  } catch (error) {
    (window as any).layoutResult = { error: String(error) };
  }
}
createRoot(document.getElementById("root")!).render(
  <div style={{ position: "fixed", inset: 0 }}>
    <Tldraw
      assetUrls={getAssetUrlsByImport()}
      onMount={(editor) => {
        void run(editor);
      }}
    />
  </div>,
);
