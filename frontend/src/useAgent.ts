import { useCallback, useEffect, useRef, useState } from "react";
import type { Editor } from "tldraw";
import {
  batchSchema,
  createCanvasBridge,
  type Batch,
  type CanvasBridge,
} from "./canvas";

export type Message = {
  role: "user" | "assistant";
  content: string;
  request_id: string;
  failed?: boolean;
};
export function useAgent(editor: Editor | null, board: string) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [connection, setConnection] = useState("Connecting");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [model, setModel] = useState("Gemini");
  const [configured, setConfigured] = useState(false);
  const [approval, setApproval] = useState<Batch | null>(null);
  const bridge = useRef<CanvasBridge | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const active = useRef<string | null>(null);
  const preparing = useRef(false);
  const send = useCallback((event: unknown) => {
    if (socket.current?.readyState !== WebSocket.OPEN) return false;
    socket.current.send(JSON.stringify(event));
    return true;
  }, []);
  const acknowledge = useCallback(
    (batch: Batch, accept: boolean) => {
      if (!bridge.current || active.current !== batch.request_id) return;
      let ok = false,
        reason = "User declined this edit.";
      if (accept) {
        try {
          bridge.current.apply(batch);
          ok = true;
          reason = "";
        } catch (e) {
          reason = e instanceof Error ? e.message : "Canvas operation failed";
        }
      }
      send({
        type: "ack",
        batch_id: batch.batch_id,
        ok,
        error: reason,
        canvas: bridge.current.snapshot(),
      });
      setStatus(ok ? batch.explanation : reason);
      setApproval(null);
    },
    [send],
  );

  useEffect(() => {
    if (!editor) return;
    let disposed = false,
      attempt = 0;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    bridge.current = createCanvasBridge(editor);
    setMessages([]);
    setError("");
    setApproval(null);
    setBusy(false);
    active.current = null;
    const sync = () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        if (bridge.current)
          send({ type: "canvas", canvas: bridge.current.snapshot() });
      }, 150);
    };
    const offDocument = editor.store.listen(sync, { scope: "document" });
    const offSession = editor.store.listen(sync, { scope: "session" });
    function connect() {
      if (disposed) return;
      setConnection(attempt ? "Reconnecting" : "Connecting");
      const ws = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws/${board}`,
      );
      socket.current = ws;
      ws.onmessage = (event) => {
        if (disposed) return;
        try {
          const data = JSON.parse(event.data);
          switch (data.type) {
            case "ready":
              attempt = 0;
              setConnection("Connected");
              setConfigured(data.configured);
              setModel(data.model);
              setMessages(data.history);
              setError("");
              sync();
              break;
            case "started":
              setStatus("Thinking about your canvas…");
              break;
            case "status":
              if (data.request_id === active.current) setStatus(data.text);
              break;
            case "token":
              if (data.request_id !== active.current) break;
              setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (
                  last?.role === "assistant" &&
                  last.request_id === data.request_id
                )
                  return [
                    ...prev.slice(0, -1),
                    { ...last, content: last.content + data.text },
                  ];
                return [
                  ...prev,
                  {
                    role: "assistant",
                    content: data.text,
                    request_id: data.request_id,
                  },
                ];
              });
              break;
            case "actions": {
              const batch = batchSchema.parse(data);
              if (batch.request_id !== active.current) break;
              if (
                batch.requires_approval ||
                batch.operations.some((op) => op.op === "delete_shape")
              ) {
                setApproval(batch);
                setStatus("Waiting for your approval");
              } else acknowledge(batch, true);
              break;
            }
            case "dismiss_actions":
              setApproval((prev) =>
                prev?.batch_id === data.batch_id ? null : prev,
              );
              break;
            case "done":
              if (data.request_id !== active.current) break;
              setMessages((prev) => {
                const last = prev[prev.length - 1];
                const message: Message = {
                  role: "assistant",
                  content: data.message,
                  request_id: data.request_id,
                  failed: data.status === "failed",
                };
                return last?.role === "assistant" &&
                  last.request_id === data.request_id
                  ? [...prev.slice(0, -1), message]
                  : [...prev, message];
              });
              active.current = null;
              setBusy(false);
              setApproval(null);
              setStatus("");
              break;
            case "error":
              setError(data.message);
              if (data.request_id === active.current) {
                active.current = null;
                setBusy(false);
              }
              break;
          }
        } catch {
          setError(
            "Received invalid data from the server. Stop this request and reconnect.",
          );
        }
      };
      ws.onerror = () =>
        setError(
          "Cannot reach the agent server. Check that the backend is running.",
        );
      ws.onclose = (event) => {
        if (disposed) return;
        setConnection("Disconnected");
        setBusy(false);
        active.current = null;
        setApproval(null);
        setStatus("");
        if (event.code === 1008) return;
        reconnect = setTimeout(connect, Math.min(1000 * 2 ** attempt++, 15000));
      };
    }
    connect();
    const heartbeat = setInterval(() => send({ type: "ping" }), 20000);
    return () => {
      disposed = true;
      clearTimeout(reconnect);
      clearTimeout(debounce);
      clearInterval(heartbeat);
      offDocument();
      offSession();
      socket.current?.close();
      socket.current = null;
      bridge.current = null;
    };
  }, [editor, board, send, acknowledge]);

  async function submit(text: string) {
    if (active.current || !bridge.current || !text.trim() || !configured)
      return false;
    const canvas = bridge.current.snapshot();
    if (canvas.total_shapes > 400) {
      setError(
        "This page exceeds the 400-shape agent context limit. Use a smaller page.",
      );
      return false;
    }
    const request_id = crypto.randomUUID();
    const sourceBridge = bridge.current;
    active.current = request_id;
    preparing.current = true;
    setBusy(true);
    setError("");
    setStatus("Reading your canvas…");
    try {
      let canvas_image: string | undefined;
      if (editor && editor.getCurrentPageShapes().length) {
        const bounds = editor.getCurrentPageBounds();
        const image = await editor.toImageDataUrl(
          editor.getCurrentPageShapes(),
          {
            format: "jpeg",
            quality: 0.85,
            background: true,
            darkMode: false,
            padding: 24,
            pixelRatio: 1,
            scale: bounds
              ? Math.min(2, 1600 / Math.max(bounds.w + 48, bounds.h + 48))
              : 1,
          },
        );
        if (image.url.length > 650_000)
          throw new Error(
            "Canvas image is too large. Move the problem to a smaller page.",
          );
        canvas_image = image.url;
      }
      if (active.current !== request_id || bridge.current !== sourceBridge)
        return false;
      const now = sourceBridge.snapshot();
      if (now.revision !== canvas.revision || now.page_id !== canvas.page_id)
        throw new Error(
          "The canvas changed while being read. Please send your message again.",
        );
      const event = {
        type: "chat",
        request_id,
        message: text.trim(),
        canvas,
        canvas_image,
      };
      if (new TextEncoder().encode(JSON.stringify(event)).length > 950_000)
        throw new Error("Canvas context is too large. Use a smaller page.");
      if (!send(event))
        throw new Error("Reconnect to the server before sending.");
      preparing.current = false;
      setStatus("Thinking about your canvas…");
      setMessages((prev) => [
        ...prev,
        { role: "user", content: text.trim(), request_id },
      ]);
      return true;
    } catch (e) {
      if (active.current === request_id) {
        active.current = null;
        preparing.current = false;
        setBusy(false);
        setStatus("");
        setError(
          e instanceof Error
            ? e.message
            : "Could not read the canvas image. Try again or type the problem in chat.",
        );
      }
      return false;
    }
  }
  function cancel() {
    if (preparing.current) {
      active.current = null;
      preparing.current = false;
      setBusy(false);
      setStatus("");
      return;
    }
    send({ type: "cancel" });
    setApproval(null);
    setStatus("Stopping…");
  }
  return {
    messages,
    connection,
    busy,
    status,
    error,
    model,
    configured,
    approval,
    submit,
    cancel,
    approve: () => approval && acknowledge(approval, true),
    reject: () => approval && acknowledge(approval, false),
    clearError: () => setError(""),
  };
}
