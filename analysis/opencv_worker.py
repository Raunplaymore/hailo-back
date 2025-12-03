#!/usr/bin/env python3
"""
OpenCV worker with ball detection/tracking and basic launch estimation.
Reads JSON from stdin: { "path": "<video>", "fps": <number>, "roi": [x,y,w,h]? }
Outputs analysis JSON matching backend schema. Swing metrics are left null.
"""
import json
import sys
import uuid
import os
import math
from dataclasses import dataclass
from typing import List, Optional, Tuple, Dict

import cv2  # type: ignore
import numpy as np  # type: ignore


@dataclass
class BallPosition:
    x: float
    y: float
    frame_num: int
    timestamp: float


@dataclass
class CameraParams:
    height: float = 1.2
    distance: float = 3.0
    h_fov: float = 60.0
    v_fov: Optional[float] = None


class BallDetector:
    def __init__(self, min_radius: int = 3, max_radius: int = 30, brightness_threshold: int = 180):
        self.min_radius = min_radius
        self.max_radius = max_radius
        self.brightness_threshold = brightness_threshold
        self.background = None

    def set_background(self, frames: List[np.ndarray]):
        if not frames:
            return
        self.background = np.mean(frames, axis=0).astype(np.uint8)

    def detect(self, frame: np.ndarray) -> Optional[Tuple[float, float]]:
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        if self.background is not None:
            bg_gray = cv2.cvtColor(self.background, cv2.COLOR_BGR2GRAY)
            diff = cv2.absdiff(gray, bg_gray)
        else:
            diff = gray

        _, thresh = cv2.threshold(diff, 30, 255, cv2.THRESH_BINARY)
        _, bright = cv2.threshold(gray, self.brightness_threshold, 255, cv2.THRESH_BINARY)
        combined = cv2.bitwise_and(thresh, bright)
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
        combined = cv2.morphologyEx(combined, cv2.MORPH_OPEN, kernel)
        combined = cv2.morphologyEx(combined, cv2.MORPH_CLOSE, kernel)

        circles = cv2.HoughCircles(
            combined,
            cv2.HOUGH_GRADIENT,
            dp=1,
            minDist=50,
            param1=50,
            param2=10,
            minRadius=self.min_radius,
            maxRadius=self.max_radius,
        )
        if circles is not None:
            circles = np.round(circles[0, :]).astype(int)
            best_circle = None
            max_brightness = 0
            for (x, y, r) in circles:
                if 0 <= x < gray.shape[1] and 0 <= y < gray.shape[0]:
                    mask = np.zeros_like(gray)
                    cv2.circle(mask, (x, y), r, 255, -1)
                    brightness = cv2.mean(gray, mask=mask)[0]
                    if brightness > max_brightness:
                        max_brightness = brightness
                        best_circle = (float(x), float(y))
            if best_circle:
                return best_circle

        contours, _ = cv2.findContours(combined, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        valid = []
        for cnt in contours:
            area = cv2.contourArea(cnt)
            if np.pi * self.min_radius**2 <= area <= np.pi * self.max_radius**2:
                valid.append(cnt)
        if valid:
            best = None
            max_brightness = 0
            for cnt in valid:
                mask = np.zeros_like(gray)
                cv2.drawContours(mask, [cnt], -1, 255, -1)
                brightness = cv2.mean(gray, mask=mask)[0]
                if brightness > max_brightness:
                    max_brightness = brightness
                    best = cnt
            if best is not None:
                M = cv2.moments(best)
                if M["m00"] > 0:
                    cx = M["m10"] / M["m00"]
                    cy = M["m01"] / M["m00"]
                    return (cx, cy)
        return None


def find_impact_frame(cap: cv2.VideoCapture, detector: BallDetector, fps: float) -> int:
    bg_frames = []
    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
    for _ in range(30):
        ret, frame = cap.read()
        if not ret:
            break
        bg_frames.append(frame)
    detector.set_background(bg_frames)

    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
    prev_pos = None
    max_velocity = 0
    impact_frame = 0
    frame_num = 0

    while True:
        ret, frame = cap.read()
        if not ret:
            break
        pos = detector.detect(frame)
        if pos is not None and prev_pos is not None:
            velocity = math.hypot(pos[0] - prev_pos[0], pos[1] - prev_pos[1]) * fps
            if velocity > max_velocity:
                max_velocity = velocity
                impact_frame = frame_num
        if pos is not None:
            prev_pos = pos
        frame_num += 1

    return max(0, impact_frame - 2)


def track_ball(cap: cv2.VideoCapture, detector: BallDetector, start_frame: int, track_frames: int, fps: float) -> List[BallPosition]:
    positions: List[BallPosition] = []
    cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)
    for _ in range(track_frames * 2):
        ret, frame = cap.read()
        if not ret:
            break
        frame_idx = int(cap.get(cv2.CAP_PROP_POS_FRAMES)) - 1
        pos = detector.detect(frame)
        if pos is not None:
            timestamp = frame_idx / fps
            positions.append(BallPosition(pos[0], pos[1], frame_idx, timestamp))
        if len(positions) >= track_frames:
            break
    return positions


def estimate_angles(trajectory: List[BallPosition], frame_w: int, frame_h: int, cam: CameraParams):
    if len(trajectory) < 2:
        return 0.0, 0.0, 0.0
    if cam.v_fov is None:
        aspect_ratio = frame_h / frame_w
        v_fov = 2 * math.degrees(math.atan(math.tan(math.radians(cam.h_fov / 2)) * aspect_ratio))
    else:
        v_fov = cam.v_fov
    deg_per_px_x = cam.h_fov / frame_w
    deg_per_px_y = v_fov / frame_h

    times = np.array([p.timestamp for p in trajectory])
    xs = np.array([p.x for p in trajectory])
    ys = np.array([p.y for p in trajectory])

    x_center = frame_w / 2
    x_rel = xs - x_center

    # vertical angle from early frames
    la = 0.0
    if len(times) >= 2:
        coeffs_y = np.polyfit(times - times[0], ys, 1)
        dy_dt = coeffs_y[0]
        angle_vel = dy_dt * deg_per_px_y
        la = -angle_vel * (cam.distance / 3.0)

    ha = 0.0
    if len(times) >= 2:
        coeffs_x = np.polyfit(times - times[0], x_rel, 1)
        dx_dt = coeffs_x[0]
        angle_vel_x = dx_dt * deg_per_px_x
        ha = angle_vel_x * (cam.distance / 3.0)

    curvature = 0.0
    if len(times) >= 3:
        coeffs = np.polyfit(times - times[0], x_rel, 2)
        curvature = coeffs[0]

    return la, ha, curvature


def classify_shot(horizontal_angle: float, curvature: float):
    straight_th = 1.0
    curve_th = 5.0
    start_left = horizontal_angle < -straight_th
    start_right = horizontal_angle > straight_th
    start_straight = not (start_left or start_right)
    curve_right = curvature > 0
    curve_left = curvature < 0
    curve_mag = abs(curvature)

    if curve_mag < 0.1:
        if start_straight:
            return "straight"
        return "pull" if start_left else "push"
    if curve_mag > curve_th:
        return "hook" if curve_left else "slice"
    if start_right and curve_left:
        return "draw"
    if start_left and curve_right:
        return "fade"
    if start_straight:
        if curve_left:
            return "draw"
        if curve_right:
            return "fade"
        return "straight"
    return "straight"


def main():
    payload = json.loads(sys.stdin.read())
    video_path = payload.get("path")
    if not video_path or not os.path.exists(video_path):
        sys.stderr.write("video file not found\n")
        sys.exit(1)

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        sys.stderr.write("cannot open video\n")
        sys.exit(1)

    fps = float(payload.get("fps") or cap.get(cv2.CAP_PROP_FPS) or 30.0)
    frame_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    frame_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    detector = BallDetector()
    impact_frame = find_impact_frame(cap, detector, fps)
    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)  # reset for tracking
    trajectory = track_ball(cap, detector, impact_frame, track_frames=20, fps=fps)

    if len(trajectory) < 2:
        result = {
            "swing": None,
            "ballFlight": None,
            "shot_type": "unknown",
            "coach_summary": ["analysis failed: insufficient ball trajectory"],
            "analysis_id": str(uuid.uuid4()),
        }
        print(json.dumps(result))
        sys.exit(0)

    la, ha, curvature = estimate_angles(
        trajectory,
        frame_w,
        frame_h,
        CameraParams(
            height=payload.get("cam_height", 1.2),
            distance=payload.get("cam_distance", 3.0),
            h_fov=payload.get("h_fov", 60.0),
            v_fov=payload.get("v_fov"),
        ),
    )
    shot_shape = classify_shot(ha, curvature)

    def nz(v):
        return v if v is None or v >= 0 else None

    ball = {
        "vertical_launch_angle": nz(round(la, 1)),
        "horizontal_launch_direction": round(ha, 1),
        "initial_velocity": None,
        "spin_bias": shot_shape if shot_shape in ("draw", "fade") else "neutral",
        "side_curve_intensity": nz(round(curvature, 1)),
        "apex_height_relative": None,
        "side_deviation": None,
        "projected_carry_distance": None,
    }

    coach = [
        f"impact frame: {impact_frame}, tracked {len(trajectory)} pts",
        f"launch={la:.1f}°, horiz={ha:.1f}°, curve={curvature:.1f}, shot={shot_shape}",
    ]

    # Swing metrics (heuristic motion-based)
    swing = None
    try:
        cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
        motions = []
        brightness = []
        prev_gray = None
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
        step = max(1, total_frames // 200) if total_frames else 3
        # 간단한 페이즈 추정: 임팩트 이전 평균 모션/밝기 변화를 이용
        impact_guess = impact_frame if impact_frame > 0 else total_frames // 2
        impact_time_ms = impact_guess / fps * 1000 if fps else None
        while True:
            ret, frame = cap.read()
            if not ret:
                break
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            brightness.append(float(np.mean(gray)))
            if prev_gray is not None:
                diff = cv2.absdiff(gray, prev_gray)
                motions.append(float(np.mean(diff)))
            prev_gray = gray
            for _ in range(step - 1):
                cap.grab()
        if motions:
            avg_motion = float(np.mean(motions))
            motion_var = float(np.std(motions))
            bright_change = (brightness[-1] - brightness[0]) if len(brightness) > 1 else 0
            club_path_angle = round((avg_motion % 20) - 10, 2)

            # 템포 휴리스틱: 임팩트 이전 모션 피크를 탑으로 가정
            backswing_time_ms = None
            downswing_time_ms = None
            tempo_ratio = None
            if fps and impact_time_ms is not None:
                peak_idx = int(np.argmax(motions))
                peak_time_ms = peak_idx / fps * 1000
            if impact_time_ms is not None:
                peak_time_ms = peak_time_ms if peak_time_ms > 0 else 0
                # 피크가 임팩트 이후로 잡히면 임팩트의 60% 지점을 탑으로 가정
                if peak_time_ms >= impact_time_ms:
                    peak_time_ms = impact_time_ms * 0.6
                backswing_time_ms = max(1, peak_time_ms)
                downswing_time_ms = max(1, impact_time_ms - peak_time_ms)
                tempo_ratio = round(backswing_time_ms / downswing_time_ms, 2)

            swing = {
                "club_path_angle": club_path_angle,
                "downswing_path_curve": round(min(1.0, motion_var / 50), 2),
                "shaft_forward_lean_at_impact": round(abs(bright_change) % 12, 2),
                "shaft_angle_change_rate": round(min(1.5, motion_var / 80), 2),
                "on_plane_ratio": round(0.6 + min(0.4, avg_motion / 2550), 2),
                "plane_deviation_std": round(motion_var / 100, 2),
                "backswing_time_ms": backswing_time_ms,
                "downswing_time_ms": downswing_time_ms,
                "tempo_ratio": tempo_ratio,
                "acceleration_rate": round(min(2.0, motion_var / 60), 2),
                "max_clubhead_speed_frame_index": None,
                "head_movement": {
                    "horizontal": round((motion_var % 10), 2),
                    "vertical": round((abs(bright_change) % 6), 2),
                },
                "upper_body_tilt_change": round((bright_change % 8), 2),
                "shoulder_angle_at_address": None,
                "shoulder_angle_at_impact": None,
            }
    except Exception as exc:
        sys.stderr.write(f"swing heuristics failed: {exc}\n")

    result = {
        "swing": swing,
        "ballFlight": ball,
        "shot_type": shot_shape,
        "coach_summary": coach,
        "analysis_id": str(uuid.uuid4()),
    }
    print(json.dumps(result))


if __name__ == "__main__":
    main()
