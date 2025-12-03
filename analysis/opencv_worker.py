#!/usr/bin/env python3
"""
OpenCV/ML worker (heuristic). Reads JSON from stdin:
{ "path": "<video>", "fps": <number>, "roi": [x,y,w,h]? }
Outputs analysis JSON matching backend schema. Uses OpenCV if available,
otherwise falls back to filesize-based pseudo metrics.
"""
import json
import sys
import uuid
import os

try:
    import cv2  # type: ignore
    import numpy as np  # type: ignore
except ImportError:
    cv2 = None
    np = None


def pseudo_metrics_from_filesize(size_bytes: int):
    basis = max(size_bytes, 1)

    def norm(v, scale=1.0):
        return round((v % 1000) / 1000 * scale, 2)

    return {
        "swing": {
            "club_path_angle": norm(basis, 20) - 10,
            "downswing_path_curve": norm(basis // 2, 0.5),
            "shaft_forward_lean_at_impact": norm(basis // 3, 15),
            "shaft_angle_change_rate": norm(basis // 5, 1.5),
            "on_plane_ratio": round(0.5 + norm(basis // 7, 0.5), 2),
            "plane_deviation_std": norm(basis // 11, 2),
            "backswing_time_ms": 700 + int(basis % 200),
            "downswing_time_ms": 200 + int((basis // 13) % 120),
            "tempo_ratio": round(
                (700 + int(basis % 200))
                / max(1, (200 + int((basis // 13) % 120))),
                2,
            ),
            "acceleration_rate": norm(basis // 17, 2),
            "max_clubhead_speed_frame_index": int(basis % 180),
            "head_movement": {
                "horizontal": norm(basis // 19, 5),
                "vertical": norm(basis // 23, 3),
            },
            "upper_body_tilt_change": norm(basis // 29, 6),
            "shoulder_angle_at_address": norm(basis // 31, 20),
            "shoulder_angle_at_impact": norm(basis // 37, 25),
        },
        "ballFlight": {
            "vertical_launch_angle": norm(basis // 41, 18),
            "horizontal_launch_direction": norm(basis // 43, 6) - 3,
            "initial_velocity": round(0.8 + norm(basis // 47, 0.4), 2),
            "spin_bias": "fade" if basis % 2 else "draw",
            "side_curve_intensity": norm(basis // 53, 0.4),
            "apex_height_relative": norm(basis // 59, 0.6),
            "side_deviation": norm(basis // 61, 15) * (-1 if basis % 2 else 1),
            "projected_carry_distance": 130 + int((basis // 67) % 60),
        },
    }


def run_opencv_metrics(path, fps_hint=None, roi=None):
    if cv2 is None or np is None:
        raise RuntimeError("OpenCV/NumPy not available")

    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise RuntimeError("Cannot open video")

    fps = float(fps_hint) if fps_hint else cap.get(cv2.CAP_PROP_FPS) or 30.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
    step = max(1, total_frames // 200) if total_frames else 3

    prev_gray = None
    motions = []
    brightness = []

    while True:
        ret, frame = cap.read()
        if not ret:
            break
        if roi and len(roi) == 4:
            x, y, w, h = roi
            frame = frame[int(y) : int(y + h), int(x) : int(x + w)]
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        brightness.append(float(np.mean(gray)))
        if prev_gray is not None:
            diff = cv2.absdiff(gray, prev_gray)
            motions.append(float(np.mean(diff)))
        prev_gray = gray
        for _ in range(step - 1):
            cap.grab()

    cap.release()
    if not motions:
        raise RuntimeError("Insufficient frames for analysis")

    avg_motion = float(np.mean(motions))
    motion_var = float(np.std(motions))
    bright_change = (brightness[-1] - brightness[0]) if len(brightness) > 1 else 0

    swing = {
        "club_path_angle": round((avg_motion % 20) - 10, 2),
        "downswing_path_curve": round(min(1.0, motion_var / 50), 2),
        "shaft_forward_lean_at_impact": round(abs(bright_change) % 12, 2),
        "shaft_angle_change_rate": round(min(1.5, motion_var / 80), 2),
        "on_plane_ratio": round(0.6 + min(0.4, avg_motion / 2550), 2),
        "plane_deviation_std": round(motion_var / 100, 2),
        "backswing_time_ms": int(max(400, min(900, total_frames / fps * 600))),
        "downswing_time_ms": int(max(150, min(350, avg_motion * 0.5))),
        "tempo_ratio": round(
            max(
                1.5,
                min(
                    4.0,
                    (max(400, min(900, total_frames / fps * 600)))
                    / max(150, min(350, avg_motion * 0.5)),
                ),
            ),
            2,
        ),
        "acceleration_rate": round(min(2.0, motion_var / 60), 2),
        "max_clubhead_speed_frame_index": int(
            min(total_frames or 0, avg_motion % max(total_frames or 1, 1))
        ),
        "head_movement": {
            "horizontal": round((motion_var % 10), 2),
            "vertical": round((abs(bright_change) % 6), 2),
        },
        "upper_body_tilt_change": round((bright_change % 8), 2),
        "shoulder_angle_at_address": round((avg_motion % 25), 2),
        "shoulder_angle_at_impact": round((avg_motion % 25) + 4, 2),
    }

    ball = {
        "vertical_launch_angle": round(8 + (avg_motion % 10), 2),
        "horizontal_launch_direction": round(((bright_change % 6) - 3), 2),
        "initial_velocity": round(0.9 + (avg_motion % 20) / 100, 2),
        "spin_bias": "fade" if bright_change >= 0 else "draw",
        "side_curve_intensity": round(min(0.4, motion_var / 200), 2),
        "apex_height_relative": round(min(0.7, avg_motion / 2000), 2),
        "side_deviation": round((motion_var % 12) * (1 if bright_change >= 0 else -1), 2),
        "projected_carry_distance": int(140 + (avg_motion % 50)),
    }

    shot_type = ball["spin_bias"]
    coach_summary = [
        f"cv2 heuristic analysis for {path}",
        f"motion={avg_motion:.2f}, brightnessΔ={bright_change:.2f}",
    ]
    return {"swing": swing, "ballFlight": ball, "shot_type": shot_type, "coach_summary": coach_summary}


def analyze(payload):
    if cv2 is not None and np is not None:
        try:
            metrics = run_opencv_metrics(
                payload.get("path"),
                payload.get("fps"),
                payload.get("roi"),
            )
            return {**metrics, "analysis_id": str(uuid.uuid4())}
        except Exception as exc:
            sys.stderr.write(f"opencv worker fallback: {exc}\n")

    try:
        stat = os.stat(payload.get("path"))
        metrics = pseudo_metrics_from_filesize(stat.st_size)
    except Exception:
        metrics = pseudo_metrics_from_filesize(1)
    return {
        **metrics,
        "shot_type": metrics["ballFlight"]["spin_bias"],
        "coach_summary": [
            "pseudo analysis (no cv2) for {path}".format(path=payload.get("path")),
            "replace with real OpenCV/ML pipeline when ready",
        ],
        "analysis_id": str(uuid.uuid4()),
    }


def main():
    payload = json.loads(sys.stdin.read())
    result = analyze(payload)
    sys.stdout.write(json.dumps(result))


if __name__ == "__main__":
    main()
