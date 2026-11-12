"""Short, transactional SQLite writes. No provider credentials are persisted."""
import json
import sqlite3
from pathlib import Path

class Storage:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        with self.connect() as db:
            db.executescript('''
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS messages (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT,
                    board TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
                    request_id TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
                CREATE INDEX IF NOT EXISTS messages_board ON messages(board, seq);
                CREATE TABLE IF NOT EXISTS requests (
                    board TEXT NOT NULL, id TEXT NOT NULL, status TEXT NOT NULL,
                    PRIMARY KEY(board, id));
                CREATE TABLE IF NOT EXISTS actions (
                    id TEXT PRIMARY KEY, board TEXT NOT NULL, request_id TEXT NOT NULL,
                    payload TEXT NOT NULL, result TEXT NOT NULL);
            ''')
            db.execute("INSERT INTO messages(board,role,content,request_id) SELECT board,'assistant','This request was interrupted by a server restart. Check the canvas before retrying.',id FROM requests WHERE status='running'")
            db.execute("UPDATE requests SET status='interrupted' WHERE status='running'")

    def connect(self):
        return sqlite3.connect(self.path, timeout=5)

    def history(self, board):
        with self.connect() as db:
            rows = db.execute('SELECT role, content, request_id FROM messages WHERE board=? ORDER BY seq DESC LIMIT 100', (board,)).fetchall()
        return [dict(role=r[0], content=r[1], request_id=r[2]) for r in reversed(rows)]

    def start(self, board, request_id, message):
        with self.connect() as db:
            try:
                db.execute("INSERT INTO requests VALUES (?,?,'running')", (board, request_id))
            except sqlite3.IntegrityError:
                return False
            db.execute('INSERT INTO messages(board,role,content,request_id) VALUES (?,?,?,?)', (board, 'user', message, request_id))
        return True

    def finish(self, board, request_id, content, status='complete'):
        with self.connect() as db:
            db.execute('UPDATE requests SET status=? WHERE board=? AND id=?', (status, board, request_id))
            db.execute('INSERT INTO messages(board,role,content,request_id) VALUES (?,?,?,?)', (board, 'assistant', content, request_id))

    def audit(self, board, request_id, batch_id, payload, result):
        with self.connect() as db:
            db.execute('INSERT OR REPLACE INTO actions VALUES (?,?,?,?,?)', (batch_id, board, request_id, json.dumps(payload), json.dumps(result)))
