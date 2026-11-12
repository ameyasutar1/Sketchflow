import {
  Component,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { Tldraw, type Editor } from "tldraw";
import {
  ArrowUp,
  Check,
  Download,
  LoaderCircle,
  MessageSquare,
  Plus,
  Sparkles,
  Square,
  Upload,
  X,
} from "lucide-react";
import { useAgent } from "./useAgent";
import { ChatMarkdown } from "./ChatMarkdown";
import { tidyCanvasDiagram } from "./canvas";
import { getAssetUrlsByImport } from "@tldraw/assets/imports.vite";
import "tldraw/tldraw.css";

const assetUrls = getAssetUrlsByImport();

type Board = { id: string; name: string };
function readBoards(): Board[] {
  try {
    const value = JSON.parse(localStorage.getItem("canvas-boards") || "null");
    if (
      Array.isArray(value) &&
      value.length &&
      value.every(
        (b) => typeof b.name === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(b.id),
      )
    )
      return value;
  } catch {
    /* use default */
  }
  return [{ id: "main", name: "My first canvas" }];
}

class CanvasBoundary extends Component<
  { children: ReactNode },
  { error: boolean }
> {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  componentDidCatch(_error: Error, _info: ErrorInfo) {
    /* Never log canvas contents or credentials. */
  }
  render() {
    return this.state.error ? (
      <div className="canvas-failure">
        <h2>Canvas couldn’t open</h2>
        <p>Your saved data has not been deleted. Reload to try again.</p>
        <button onClick={() => location.reload()}>Reload canvas</button>
      </div>
    ) : (
      this.props.children
    );
  }
}

function Workspace({
  board,
  onRename,
  onNew,
  boards,
  onChoose,
}: {
  board: Board;
  onRename: (name: string) => void;
  onNew: () => void;
  boards: Board[];
  onChoose: (id: string) => void;
}) {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [prompt, setPrompt] = useState("");
  const [localError, setLocalError] = useState("");
  const [chatOpen, setChatOpen] = useState(true);
  const agent = useAgent(editor, board.id);
  const bottom = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [agent.messages, agent.status]);
  const mount = useCallback(
    (instance: Editor) => {
      try {
        if (board.id === "main" && !localStorage.getItem("canvas-migrated")) {
          const old = localStorage.getItem("canvas-document-v1");
          if (old && instance.getCurrentPageShapes().length === 0)
            instance.loadSnapshot(JSON.parse(old));
          localStorage.setItem("canvas-migrated", "1");
        }
      } catch {
        setLocalError(
          "The previous canvas could not be imported. Its original browser backup is still retained.",
        );
      }
      setEditor(instance);
      return () => setEditor(null);
    },
    [board.id],
  );
  async function submit(text = prompt) {
    if (await agent.submit(text)) setPrompt("");
  }
  function exportBoard() {
    if (!editor) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(editor.getSnapshot())], {
        type: "application/json",
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `${board.name.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function importBoard(event: React.ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0];
    event.target.value = "";
    if (!selected || !editor) return;
    if (selected.size > 10_000_000) {
      setLocalError("Choose a canvas backup smaller than 10 MB.");
      return;
    }
    if (editor.getCurrentPageShapes().length) {
      setLocalError("Create an empty board before importing a backup.");
      return;
    }
    const previous = editor.getSnapshot();
    try {
      editor.loadSnapshot(JSON.parse(await selected.text()));
      editor.zoomToFit();
    } catch {
      editor.loadSnapshot(previous);
      setLocalError("This file is not a valid canvas backup.");
    }
  }
  return (
    <div className="workspace">
      <header className="topbar">
        <div className="identity">
          <span className="logo">
            <Sparkles size={19} />
          </span>
          <strong>canvas</strong>
          <span className="divider">/</span>
          <input
            aria-label="Board name"
            className="board-name"
            value={board.name}
            maxLength={80}
            onChange={(e) => onRename(e.target.value)}
          />
          <span className="local-badge">LOCAL WORKSPACE</span>
        </div>
        <div className="header-actions">
          <select
            aria-label="Switch board"
            disabled={agent.busy}
            value={board.id}
            onChange={(e) => onChoose(e.target.value)}
          >
            {boards.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name || "Untitled"}
              </option>
            ))}
          </select>
          <button onClick={onNew} disabled={agent.busy}>
            <Plus size={15} />
            <span>New board</span>
          </button>
          <button
            disabled={!editor || agent.busy}
            title="Arrange connected diagrams and their explanations. Applies to selected components, or the whole page. Undo with Cmd/Ctrl+Z."
            onClick={() => {
              if (!editor) return;
              try {
                tidyCanvasDiagram(editor);
              } catch (error) {
                setLocalError(
                  error instanceof Error
                    ? error.message
                    : "Diagram layout failed",
                );
              }
            }}
          >
            Tidy diagram
          </button>
          <button
            title="Export canvas backup"
            aria-label="Export canvas backup"
            onClick={exportBoard}
          >
            <Download size={16} />
          </button>
          <button
            title="Import canvas backup into an empty board"
            aria-label="Import canvas backup"
            disabled={agent.busy}
            onClick={() => file.current?.click()}
          >
            <Upload size={16} />
          </button>
          <button
            className={chatOpen ? "active" : ""}
            onClick={() => setChatOpen(!chatOpen)}
            aria-label="Toggle assistant"
          >
            <MessageSquare size={16} />
          </button>
          <input
            ref={file}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={importBoard}
          />
        </div>
      </header>
      {localError && (
        <div role="alert" className="banner">
          {localError}
          <button onClick={() => setLocalError("")} aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      )}
      <div className="work-area">
        <section className="board" aria-label="Drawing canvas">
          <CanvasBoundary>
            <Tldraw
              persistenceKey={`canvas-v2-${board.id}`}
              onMount={mount}
              assetUrls={assetUrls}
              licenseKey={import.meta.env.VITE_TLDRAW_LICENSE_KEY}
            />
          </CanvasBoundary>
        </section>
        {chatOpen && (
          <aside className="assistant" aria-label="Canvas assistant">
            <div className="assistant-header">
              <div>
                <div className="assistant-title">
                  <Sparkles size={16} /> Canvas assistant
                </div>
                <p>Think it. Sketch it. Make it yours.</p>
              </div>
              <span
                className={`connection ${agent.connection === "Connected" ? "online" : ""}`}
                title={agent.connection}
              />
            </div>
            <div className="model-row">
              <span>DEEP AGENTS</span>
              <span>{agent.model}</span>
            </div>
            <div
              className="conversation"
              aria-live="polite"
              aria-relevant="additions text"
            >
              {!agent.messages.length && (
                <div className="welcome">
                  <div className="welcome-symbol">
                    <Sparkles size={26} />
                  </div>
                  <h1>Ideas take shape here.</h1>
                  <p>
                    Ask me to draw something, connect your thoughts, or work
                    with what’s already on the board.
                  </p>
                  {[
                    "Draw a simple AI architecture with connected boxes",
                    "Draw a smooth wave using a black freehand stroke",
                    "What is on my canvas?",
                  ].map((text, i) => (
                    <button
                      className="suggestion"
                      key={text}
                      disabled={
                        agent.connection !== "Connected" ||
                        !agent.configured ||
                        !editor
                      }
                      onClick={() => submit(text)}
                    >
                      <span>0{i + 1}</span>
                      {text}
                      <ArrowUp size={14} />
                    </button>
                  ))}
                  <div className="privacy-note">
                    A canvas image, shape data, and your messages are sent to
                    Gemini when you ask. Edits stay editable.
                  </div>
                </div>
              )}
              {agent.messages.map((message, index) => (
                <div
                  key={`${message.request_id}-${index}`}
                  className={`message ${message.role} ${message.failed ? "failed" : ""}`}
                >
                  <div className="message-author">
                    {message.role === "user" ? "YOU" : "CANVAS"}
                  </div>
                  <div className="message-content">
                    {message.role === "assistant" ? (
                      <ChatMarkdown content={message.content} />
                    ) : (
                      message.content
                    )}
                  </div>
                </div>
              ))}
              {agent.busy && (
                <div className="progress">
                  <LoaderCircle size={13} className="spin" />
                  {agent.status || "Working…"}
                </div>
              )}
              {agent.approval && (
                <div className="approval">
                  <strong>Approve this canvas edit?</strong>
                  <p>{agent.approval.explanation}</p>
                  <small>
                    {
                      agent.approval.operations.filter(
                        (op) => op.op === "delete_shape",
                      ).length
                    }{" "}
                    object(s) will be deleted. The whole batch can be undone.
                  </small>
                  <div>
                    <button onClick={agent.reject}>Decline</button>
                    <button className="primary" onClick={agent.approve}>
                      <Check size={13} /> Apply edit
                    </button>
                  </div>
                </div>
              )}
              <div ref={bottom} />
            </div>
            {agent.error && (
              <div role="alert" className="chat-error">
                {agent.error}
                <button onClick={agent.clearError} aria-label="Dismiss error">
                  <X size={13} />
                </button>
              </div>
            )}
            {!agent.configured && agent.connection === "Connected" && (
              <div className="chat-error">
                Add GOOGLE_API_KEY to the project .env file and restart the
                backend.
              </div>
            )}
            <form
              className="composer"
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              <textarea
                aria-label="Message the canvas assistant"
                placeholder="Ask me to solve, explain, or draw…"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                maxLength={8000}
                rows={3}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing
                  ) {
                    e.preventDefault();
                    if (!agent.busy) submit();
                  }
                }}
              />
              <div className="composer-footer">
                <span>
                  {agent.connection === "Connected"
                    ? "Enter to send · Shift + Enter for newline"
                    : agent.connection + "…"}
                </span>
                {agent.busy ? (
                  <button
                    type="button"
                    className="send"
                    onClick={agent.cancel}
                    aria-label="Stop generating"
                  >
                    <Square size={14} />
                  </button>
                ) : (
                  <button
                    className="send"
                    disabled={
                      !prompt.trim() ||
                      agent.connection !== "Connected" ||
                      !agent.configured ||
                      !editor
                    }
                    aria-label="Send message"
                  >
                    <ArrowUp size={17} />
                  </button>
                )}
              </div>
            </form>
            <div className="assistant-footnote">
              Your board is saved in this browser. Export for a backup.
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const [boards, setBoards] = useState<Board[]>(readBoards);
  const [current, setCurrent] = useState(() => {
    try {
      return localStorage.getItem("canvas-current") || "main";
    } catch {
      return "main";
    }
  });
  const [saveError, setSaveError] = useState("");
  const board = boards.find((b) => b.id === current) || boards[0];
  useEffect(() => {
    try {
      localStorage.setItem("canvas-boards", JSON.stringify(boards));
      localStorage.setItem("canvas-current", board.id);
    } catch {
      setSaveError(
        "Browser storage is unavailable. Export your canvas before closing.",
      );
    }
  }, [boards, board.id]);
  function newBoard() {
    const id = crypto.randomUUID();
    setBoards((prev) => [...prev, { id, name: `Untitled ${prev.length + 1}` }]);
    setCurrent(id);
  }
  return (
    <>
      {saveError && (
        <div className="banner" role="alert">
          {saveError}
        </div>
      )}
      <Workspace
        key={board.id}
        board={board}
        boards={boards}
        onChoose={setCurrent}
        onNew={newBoard}
        onRename={(name) =>
          setBoards((prev) =>
            prev.map((b) => (b.id === board.id ? { ...b, name } : b)),
          )
        }
      />
    </>
  );
}
