import os
from pathlib import Path
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / '.env', override=False)
MODEL = os.getenv('GEMINI_MODEL', 'gemini-2.5-flash')
ORIGINS = set(os.getenv('CANVAS_ORIGINS', 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:8000,http://127.0.0.1:8000').split(','))
DATA = Path(os.getenv('CANVAS_DATA_DIR', str(ROOT / 'backend' / 'data')))
MAX_FRAME = 1_000_000
