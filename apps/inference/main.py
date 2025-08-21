import base64
import io
import os
import time
from typing import Any, Dict, List

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from PIL import Image
import onnxruntime as ort


app = FastAPI(title="webrtc-vlm inference server", version="0.1.0")


# ------------------------------- Model Loading -------------------------------

def resolve_model_path() -> str:
    # Default to the model used by the frontend for consistency
    # webrtc-vlm/apps/frontend/public/models/model.onnx relative to this file
    default_path = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "frontend", "public", "models", "model.onnx")
    )
    return os.environ.get("MODEL_PATH", default_path)


MODEL_PATH = resolve_model_path()
SESSION: ort.InferenceSession | None = None
MODEL_INPUT_SIZE = 320  # square input


def load_session() -> None:
    global SESSION
    if SESSION is not None:
        return
    providers = ["CPUExecutionProvider"]
    so = ort.SessionOptions()
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_EXTENDED
    SESSION = ort.InferenceSession(MODEL_PATH, sess_options=so, providers=providers)


@app.on_event("startup")
def _startup() -> None:
    load_session()


@app.get("/")
def root() -> JSONResponse:
    return JSONResponse({"ok": True, "model": os.path.basename(MODEL_PATH)})


# ------------------------------ Image Utilities ------------------------------

def decode_image_from_b64(data_url: str) -> Image.Image:
    # Accept plain base64 or data URLs like data:image/jpeg;base64,....
    if "," in data_url:
        _, b64 = data_url.split(",", 1)
    else:
        b64 = data_url
    img_bytes = base64.b64decode(b64)
    img = Image.open(io.BytesIO(img_bytes)).convert("RGB")
    return img


def preprocess_letterbox(img: Image.Image, model_size: int) -> tuple[np.ndarray, dict]:
    # Resize with letterbox to square model_size preserving aspect
    src_w, src_h = img.size
    scale = min(model_size / src_w, model_size / src_h)
    draw_w = int(round(src_w * scale))
    draw_h = int(round(src_h * scale))
    dx = (model_size - draw_w) // 2
    dy = (model_size - draw_h) // 2

    canvas = Image.new("RGB", (model_size, model_size), (0, 0, 0))
    resized = img.resize((draw_w, draw_h))
    canvas.paste(resized, (dx, dy))

    arr = np.asarray(canvas).astype(np.float32) / 255.0  # HWC RGB 0..1
    chw = np.transpose(arr, (2, 0, 1))  # CHW
    nchw = np.expand_dims(chw, 0)  # NCHW
    return nchw, {"dx": dx, "dy": dy, "draw_w": draw_w, "draw_h": draw_h, "model": model_size, "src_w": src_w, "src_h": src_h}


def sigmoid(x: np.ndarray) -> np.ndarray:
    return 1 / (1 + np.exp(-x))


def decode_yolov8(outputs: Dict[str, Any], lb: dict, score_thresh: float = 0.20) -> List[dict]:
    # Expect common YOLOv8 export: [1, 84, 8400]
    name = list(outputs.keys())[0]
    out = outputs[name]
    data: np.ndarray = out if isinstance(out, np.ndarray) else out.numpy() if hasattr(out, "numpy") else out
    if hasattr(out, "shape"):
        dims = list(out.shape)
    else:
        dims = []
    dets: List[dict] = []
    # Handle [1,84,8400] or [1,8400,84]
    if len(dims) == 3 and (dims[1] >= 6 or dims[2] >= 6):
        if dims[1] >= 6 and dims[2] > dims[1]:
            # [1,84,8400]
            num_classes = dims[1] - 4
            num_props = dims[2]
            x = data.reshape(dims)[0]  # [84, 8400]
        else:
            # [1,8400,84] -> transpose to [84, 8400]
            num_props = dims[1]
            num_classes = dims[2] - 4
            x = data.reshape(dims)[0].transpose(1, 0)

        # x is [84, num_props]
        boxes = x[0:4, :]  # cx,cy,w,h
        scores = x[4:4 + num_classes, :]
        # Apply sigmoid if values look unbounded
        if scores.max() > 1.0 or scores.min() < 0.0:
            scores = sigmoid(scores)
        best_cls = np.argmax(scores, axis=0)
        best_score = scores[best_cls, np.arange(num_props)]

        cx = boxes[0, :]
        cy = boxes[1, :]
        w = boxes[2, :]
        h = boxes[3, :]

        dx, dy, draw_w, draw_h = lb["dx"], lb["dy"], lb["draw_w"], lb["draw_h"]
        src_w, src_h = lb["src_w"], lb["src_h"]

        x1 = (cx - w / 2.0 - dx) / draw_w * src_w
        y1 = (cy - h / 2.0 - dy) / draw_h * src_h
        x2 = (cx + w / 2.0 - dx) / draw_w * src_w
        y2 = (cy + h / 2.0 - dy) / draw_h * src_h

        for i in range(num_props):
            s = float(best_score[i])
            if s < score_thresh:
                continue
            nx1 = max(0.0, min(1.0, float(x1[i] / src_w)))
            ny1 = max(0.0, min(1.0, float(y1[i] / src_h)))
            nx2 = max(0.0, min(1.0, float(x2[i] / src_w)))
            ny2 = max(0.0, min(1.0, float(y2[i] / src_h)))
            if nx2 <= nx1 or ny2 <= ny1:
                continue
            dets.append({
                "label": int(best_cls[i]),  # numeric id, viewer maps to label
                "score": s,
                "xmin": nx1,
                "ymin": ny1,
                "xmax": nx2,
                "ymax": ny2,
            })
    return dets


def nms(dets: List[dict], iou_thresh: float = 0.45, max_det: int = 50) -> List[dict]:
    if not dets:
        return []
    dets = sorted(dets, key=lambda d: d["score"], reverse=True)
    keep: List[dict] = []

    def iou(a: dict, b: dict) -> float:
        x1 = max(a["xmin"], b["xmin"]) ; y1 = max(a["ymin"], b["ymin"]) ; x2 = min(a["xmax"], b["xmax"]) ; y2 = min(a["ymax"], b["ymax"]) ;
        inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
        area_a = max(0.0, a["xmax"] - a["xmin"]) * max(0.0, a["ymax"] - a["ymin"]) ; area_b = max(0.0, b["xmax"] - b["xmin"]) * max(0.0, b["ymax"] - b["ymin"]) ;
        union = area_a + area_b - inter
        return 0.0 if union <= 0 else inter / union

    for d in dets:
        ok = True
        for k in keep:
            if iou(d, k) > iou_thresh:
                ok = False
                break
        if ok:
            keep.append(d)
            if len(keep) >= max_det:
                break
    return keep


# ----------------------------- WebSocket Endpoint ----------------------------

@app.websocket("/detect")
async def detect_ws(ws: WebSocket) -> None:
    await ws.accept()
    while True:
        try:
            msg = await ws.receive_json()
        except WebSocketDisconnect:
            break
        except Exception:
            # Ignore malformed frames
            continue

        frame_id = int(msg.get("frame_id", -1))
        capture_ts = float(msg.get("capture_ts", 0))
        image_b64 = msg.get("image_b64")
        if not image_b64:
            await ws.send_json({"error": "missing image_b64"})
            continue

        server_recv_ts = time.perf_counter() * 1000.0

        try:
            img = decode_image_from_b64(image_b64)
            arr, lb = preprocess_letterbox(img, MODEL_INPUT_SIZE)

            inputs: Dict[str, Any] = {SESSION.get_inputs()[0].name: arr}
            t0 = time.perf_counter() * 1000.0
            outputs_list = SESSION.run(None, inputs)
            t1 = time.perf_counter() * 1000.0
            outputs = {SESSION.get_outputs()[i].name: outputs_list[i] for i in range(len(outputs_list))}

            dets = decode_yolov8(outputs, lb, score_thresh=0.25)
            dets = nms(dets, iou_thresh=0.45, max_det=50)

            await ws.send_json({
                "frame_id": frame_id,
                "capture_ts": capture_ts,
                "recv_ts": server_recv_ts,
                "server_recv_ts": server_recv_ts,
                "inference_ts": t1,
                "inference_ms": t1 - t0,
                "detections": dets,
            })
        except Exception as e:
            await ws.send_json({"frame_id": frame_id, "error": str(e)})


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run(app, host="0.0.0.0", port=port)


