import base64
import binascii
from typing import Annotated, Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator, field_validator

Coordinate = Annotated[float, Field(ge=-100_000, le=100_000, allow_inf_nan=False)]
ShapeId = Annotated[str, Field(pattern=r'^shape:[a-zA-Z0-9_-]{1,100}$')]
Color = Literal['black', 'grey', 'blue', 'light-blue', 'green', 'light-green', 'red', 'light-red', 'orange', 'yellow', 'violet', 'light-violet']

class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)

class Point(StrictModel):
    x: Coordinate
    y: Coordinate

class Canvas(StrictModel):
    revision: int = Field(ge=0)
    page_id: str = Field(max_length=150)
    shapes: list[dict] = Field(max_length=400)
    selected_ids: list[str] = Field(default_factory=list, max_length=400)
    viewport: dict = Field(default_factory=dict)
    total_shapes: int = Field(default=0, ge=0)

class Operation(StrictModel):
    """All coordinates are page coordinates. Omit fields irrelevant to the operation."""
    op: Literal['create_shape', 'add_text', 'draw_stroke', 'create_arrow', 'move_shape', 'resize_shape', 'update_text', 'delete_shape']
    id: ShapeId
    kind: Literal['rectangle', 'ellipse', 'diamond'] = 'rectangle'
    x: Coordinate = 0
    y: Coordinate = 0
    w: float = Field(default=180, ge=10, le=5000)
    h: float = Field(default=100, ge=10, le=5000)
    text: str = Field(default='', max_length=2000)
    color: Color = 'black'
    points: list[Point] = Field(default_factory=list, max_length=500)
    from_id: ShapeId | None = None
    to_id: ShapeId | None = None

    @model_validator(mode='after')
    def required_fields(self):
        if self.op == 'draw_stroke' and len(self.points) < 2:
            raise ValueError('draw_stroke requires at least two points')
        if self.op == 'create_arrow' and (not self.from_id or not self.to_id or self.from_id == self.to_id):
            raise ValueError('create_arrow requires two distinct shape IDs')
        return self

class EditPlan(StrictModel):
    """Complete validated intent; transport splits this into browser batches."""
    operations: list[Operation] = Field(min_length=1, max_length=120)
    explanation: str = Field(min_length=1, max_length=500)

class EditBatch(EditPlan):
    operations: list[Operation] = Field(min_length=1, max_length=40)

class ChatRequest(StrictModel):
    type: Literal['chat']
    request_id: str = Field(pattern=r'^[a-zA-Z0-9_-]{1,100}$')
    message: str = Field(min_length=1, max_length=8000)
    canvas: Canvas
    canvas_image: str | None = Field(default=None, max_length=650_000)

    @field_validator('canvas_image')
    @classmethod
    def validate_image(cls, value):
        if value is None:
            return value
        try:
            header, encoded = value.split(',', 1)
            if header not in ('data:image/png;base64', 'data:image/jpeg;base64'):
                raise ValueError('Only inline PNG/JPEG canvas images are supported')
            data = base64.b64decode(encoded, validate=True)
            signature = b'\x89PNG\r\n\x1a\n' if 'png' in header else b'\xff\xd8\xff'
            if not data.startswith(signature):
                raise ValueError('Invalid image signature')
        except (ValueError, binascii.Error) as exc:
            raise ValueError('Invalid inline canvas image') from exc
        return value

    @model_validator(mode='after')
    def nonblank(self):
        if not self.message.strip():
            raise ValueError('Message cannot be blank')
        return self

def validate_targets(batch: EditPlan, canvas: Canvas):
    shapes = {s['id']: s for s in canvas.shapes if 'id' in s}
    for op in batch.operations:
        if op.op in ('create_shape', 'add_text', 'draw_stroke', 'create_arrow'):
            if op.id in shapes:
                raise ValueError(f'{op.id} already exists')
            if op.op == 'create_arrow' and (op.from_id not in shapes or op.to_id not in shapes):
                raise ValueError('Arrow endpoints must exist')
            shapes[op.id] = {'id': op.id}
        else:
            if op.id not in shapes:
                raise ValueError(f'{op.id} is missing; read the canvas again')
            if shapes[op.id].get('locked'):
                raise ValueError(f'{op.id} is locked')
            if op.op == 'delete_shape':
                del shapes[op.id]
