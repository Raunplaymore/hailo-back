#!/usr/bin/env python3
"""
Placeholder OpenCV/ML worker.
Reads JSON from stdin: { "path": "<video>", "fps": <number>, "roi": [x,y,w,h]? }
Outputs analysis JSON matching backend schema.
Replace stub computations with real OpenCV/ONNX logic on Raspberry Pi.
"""
import json
import sys
import uuid
import os

def pseudo_metrics_from_filesize(size_bytes: int):
    # Lightweight heuristic values derived from filesize to avoid all-zero output
    basis = max(size_bytes, 1)
    def norm(v, scale=1.0):
        return round((v % 1000) / 1000 * scale, 2)
    return {
        "swing": {
            "club_path_angle": norm(basis, 20) - 10,  # -10~+10
            "downswing_path_curve": norm(basis // 2, 0.5),
            "shaft_forward_lean_at_impact": norm(basis // 3, 15),
            "shaft_angle_change_rate": norm(basis // 5, 1.5),
            "on_plane_ratio": round(0.5 + norm(basis // 7, 0.5), 2),
            "plane_deviation_std": norm(basis // 11, 2),
            "backswing_time_ms": 700 + int(basis % 200),
            "downswing_time_ms": 200 + int((basis // 13) % 120),
            "tempo_ratio": round((700 + int(basis % 200)) / max(1, (200 + int((basis // 13) % 120))), 2),
            "acceleration_rate": norm(basis // 17, 2),
            "max_clubhead_speed_frame_index": int(basis % 180),
            "head_movement": {"horizontal": norm(basis // 19, 5), "vertical": norm(basis // 23, 3)},
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

def analyze(payload):
    try:
        stat = os.stat(payload.get("path"))
        metrics = pseudo_metrics_from_filesize(stat.st_size)
    except Exception:
        metrics = pseudo_metrics_from_filesize(1)
    return {
        **metrics,
        "shot_type": metrics["ballFlight"]["spin_bias"],
        "coach_summary": [
            f"pseudo analysis for {payload.get('path')}",
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
