#!/usr/bin/env python3
"""
Lightweight precheck to decide whether a video is likely to contain a swing.

Goal: run fast (sub-second), avoid heavy tracking/ML, and act as a gate.

Reads JSON from stdin:
  {
    "path": "<video_path>",
    "sampleWindowSec": 1.0,
    "sampleFrames": 8,
    "minDurationSec": 0.6,
    "minFrames": 20,
    "motionThreshold": 2.0,
    "resizeWidth": 160
  }

Outputs JSON:
  {
    "ok": true,
    "isSwing": true|false,
    "reason": "ok|too_short|low_motion|error",
    "metrics": { ... }
  }
"""

import json
import sys
import os
from typing import Any, Dict, Optional

import cv2  # type: ignore
import numpy as np  # type: ignore


def _to_int(v: Any, default: int) -> int:
    try:
        n = int(v)
        return n
    except Exception:
        return default


def _to_float(v: Any, default: float) -> float:
    try:
        n = float(v)
        return n
    except Exception:
        return default


def _safe_fps(v: float) -> float:
    if v is None:
        return 30.0
    try:
        v = float(v)
    except Exception:
        return 30.0
    if v <= 0 or v > 1000:
        return 30.0
    return v


def _read_payload() -> Dict[str, Any]:
    raw = sys.stdin.read()
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except Exception:
        return {}


def _mean_abs_diff(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.mean(cv2.absdiff(a, b)))


def precheck(video_path: str, cfg: Dict[str, Any]) -> Dict[str, Any]:
    if not video_path or not os.path.exists(video_path):
        return {
            "ok": True,
            "isSwing": True,
            "reason": "error",
            "metrics": {"error": "video file not found"},
        }

    sample_window_sec = _to_float(cfg.get("sampleWindowSec"), 1.0)
    sample_frames = max(3, _to_int(cfg.get("sampleFrames"), 8))
    min_duration_sec = _to_float(cfg.get("minDurationSec"), 0.6)
    min_frames = _to_int(cfg.get("minFrames"), 20)
    motion_threshold = _to_float(cfg.get("motionThreshold"), 2.0)
    resize_width = max(64, _to_int(cfg.get("resizeWidth"), 160))

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return {
            "ok": True,
            "isSwing": True,
            "reason": "error",
            "metrics": {"error": "cannot open video"},
        }

    fps = _safe_fps(cap.get(cv2.CAP_PROP_FPS))
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    duration_sec: Optional[float] = None
    if frame_count > 0 and fps > 0:
        duration_sec = frame_count / fps

    # Hard filters: too short to be a swing clip
    if duration_sec is not None and duration_sec < min_duration_sec:
        return {
            "ok": True,
            "isSwing": False,
            "reason": "too_short",
            "metrics": {
                "durationSec": duration_sec,
                "fps": fps,
                "frameCount": frame_count,
                "minDurationSec": min_duration_sec,
            },
        }
    if frame_count > 0 and frame_count < min_frames:
        return {
            "ok": True,
            "isSwing": False,
            "reason": "too_short",
            "metrics": {
                "durationSec": duration_sec,
                "fps": fps,
                "frameCount": frame_count,
                "minFrames": min_frames,
            },
        }

    # Motion gate: sample a small number of frames early and measure mean abs diff.
    max_window_frames = int(max(1.0, sample_window_sec) * fps)
    if frame_count > 0:
        window_frames = min(frame_count, max_window_frames)
    else:
        window_frames = max_window_frames

    step = max(1, window_frames // sample_frames)

    diffs = []
    frames_sampled = 0
    prev_gray = None

    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
    while frames_sampled < sample_frames:
        ret, frame = cap.read()
        if not ret:
            break

        # Resize to keep CPU cost low
        h, w = frame.shape[:2]
        if w > resize_width:
            scale = resize_width / float(w)
            frame = cv2.resize(frame, (resize_width, int(h * scale)), interpolation=cv2.INTER_AREA)

        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        if prev_gray is not None:
            diffs.append(_mean_abs_diff(prev_gray, gray))
        prev_gray = gray
        frames_sampled += 1

        # Skip ahead cheaply without decoding full frames
        for _ in range(step - 1):
            cap.grab()

    cap.release()

    if len(diffs) < 2:
        # Could not sample enough; be conservative and allow analysis.
        return {
            "ok": True,
            "isSwing": True,
            "reason": "error",
            "metrics": {
                "durationSec": duration_sec,
                "fps": fps,
                "frameCount": frame_count,
                "sampledFrames": frames_sampled,
                "error": "insufficient samples",
            },
        }

    mean_diff = float(np.mean(diffs))
    max_diff = float(np.max(diffs))

    if mean_diff < motion_threshold:
        return {
            "ok": True,
            "isSwing": False,
            "reason": "low_motion",
            "metrics": {
                "durationSec": duration_sec,
                "fps": fps,
                "frameCount": frame_count,
                "sampleWindowSec": sample_window_sec,
                "sampleFrames": sample_frames,
                "resizeWidth": resize_width,
                "motionThreshold": motion_threshold,
                "meanDiff": round(mean_diff, 3),
                "maxDiff": round(max_diff, 3),
            },
        }

    return {
        "ok": True,
        "isSwing": True,
        "reason": "ok",
        "metrics": {
            "durationSec": duration_sec,
            "fps": fps,
            "frameCount": frame_count,
            "sampleWindowSec": sample_window_sec,
            "sampleFrames": sample_frames,
            "resizeWidth": resize_width,
            "motionThreshold": motion_threshold,
            "meanDiff": round(mean_diff, 3),
            "maxDiff": round(max_diff, 3),
        },
    }


def main() -> None:
    payload = _read_payload()
    path = payload.get("path")
    cfg = payload.get("config") or payload
    result = precheck(path, cfg)
    print(json.dumps(result))


if __name__ == "__main__":
    main()

