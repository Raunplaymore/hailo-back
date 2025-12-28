# hailo-back

라즈베리파이에서 동작하는 **골프 스윙 업로드·분석 백엔드**입니다. 업로드/정적 서빙 + 간단한 OpenCV 기반 분석을 제공하며, 추후 Job/ML 파이프라인으로 확장 예정입니다.

## 필수 구성요소

- Node.js 18+
- Python 3.9+ (`python3` 명령어 제공)
- Python 패키지: `opencv-python`, `numpy`
  ```bash
  python3 -m pip install --upgrade pip
  python3 -m pip install opencv-python numpy
  ```
- `ffmpeg`, `ffprobe` (iPhone `.mov` 변환/메타데이터 추출에 사용). Raspberry Pi OS 기준:
  ```bash
  sudo apt update
  sudo apt install ffmpeg
  ```

## 빠른 실행

```bash
npm install
node server.js
# 또는 운영 경로 지정
UPLOAD_DIR=/home/ray/uploads DATA_DIR=/home/ray/data node server.js
```

- 포트: `3000`
- 업로드 경로: `UPLOAD_DIR`(기본 `./uploads`, 운영 `/home/ray/uploads`)
- 샷/세션 저장: `DATA_DIR`(기본 `./data`, 운영 `/home/ray/data`)
- 분석 서비스: `INFER_BASE_URL`(기본 `http://127.0.0.1:8002`)
- 헬스체크: `GET /health/ok.txt`
- 정적 자산: `client-dist/`를 자동 서빙하며 SPA fallback(`/index.html`)도 포함됨. 별도 프런트 빌드가 있다면 해당 폴더에 산출물 배치.

## 핵심 API 요약

- 업로드(+옵션 분석): `POST /api/upload` (form-data `video`, `?analyze=true`, `force=true`로 프리체크 무시)
- Hailo 메타 기반 분석: `POST /api/analyze/from-file` (`{ jobId, filename?, metaPath?, force? }`, `filename` 기본 `<jobId>.mp4`, 상태 `pending|running|done|failed`)
- 분석 업로드(동일): `POST /api/analyze/upload`, `POST /api/analyze`
- Job 상태 조회: `GET /api/analyze/:jobId`, `GET /api/analyze/:jobId/result`
- 파일 목록(표준): `GET /api/files/detail` → `.mp4/.mov` + 상태/분석/에러 포함
- 파일 목록(Shot 기준): `GET /api/files`
- 파일 삭제: `DELETE /api/files/:filename`
- 샷/세션: `GET /api/shots`, `GET /api/shots/:id/analysis`, `GET /api/sessions`
- 정적 파일: `/uploads/:name`

## 파일 목록/상태 규약 (`GET /api/files/detail`)

- 응답: `{ ok: true, files: [{ filename, url, shotId, jobId, analyzed, status, size, modifiedAt, analysis, errorCode?, errorMessage? }] }`
- `status`: `not-analyzed | queued | running | succeeded | failed`
- `url`: URL 인코딩된 `/uploads/...` 제공 → 그대로 `<video src>`에 사용 (공백/한글/특수문자 안전)
- 확장자: `.mp4`, `.mov` 포함

## Hailo 카메라 분석 파이프라인 (메타 기반)

- 전제: hailo-camera가 `/uploads/<jobId>.mp4`를 생성하고, 세션 종료 시 `{ jobId, filename, metaPath }`로 `POST /api/analyze/from-file` 호출.
- 백엔드는 `INFER_BASE_URL`의 `/v1/jobs`로 분석을 위임하며, `metaPath`는 그대로 전달됨(없으면 `null`).
- 상태 조회: `GET /api/analyze/:jobId`를 폴링.
- 결과는 코칭 지표 중심(`swingPlane`, `tempo`, `impactStability`), 런치 모니터 물리값(스핀/캐리/발사각) 계산 없음.

### 요청/응답 예시

```http
POST /api/analyze/from-file
Content-Type: application/json

{
  "jobId": "session-123",
  "filename": "session-123.mp4",
  "metaPath": "/tmp/session-123.meta.json",
  "force": false
}
```

```json
{
  "ok": true,
  "jobId": "session-123",
  "status": "running"
}
```

```http
GET /api/analyze/session-123
```

```json
{
  "ok": true,
  "jobId": "session-123",
  "status": "done",
  "errorMessage": null,
  "events": {
    "addressMs": 0,
    "topMs": 820,
    "impactMs": 1220,
    "finishMs": 1600
  },
  "metrics": {
    "swingPlane": { "label": "inside-out", "confidence": 0.62 },
    "tempo": { "backswingMs": 820, "downswingMs": 400, "ratio": 2.05 },
    "impactStability": { "label": "stable", "score": 0.74 }
  },
  "summary": "Swing plane inside-out. Impact stability stable. Tempo 2.05:1."
}
```

## 분석 동작 특징

- 프리체크 Abort: 스윙이 아니면 초기에 중단 → `status=failed`, `errorCode=NOT_SWING`, `errorMessage`로 안내. `force=true`로 무시 가능.
- iPhone `.mov` 지원: 필요 시 ffmpeg로 `.mp4` 리먹스/트랜스코딩 후 분석. 변환/디코딩 실패 시 `errorCode=DECODE_FAILED`.
- 분석 스키마(현 버전): `ballFlight/impact`(launch angles 등), `swing`(모션 휴리스틱), `coach_summary` 텍스트, `analysisVersion`(`opencv-v1`), `meta`(fps/width/height/durationMs). 일부 값은 검출 실패 시 `null/unknown`.

## OpenCV 워커

- `analysis/opencv_worker.py`: 공 검출/임팩트 추정/궤적 계산 → 발사각/수평각/곡률/샷 타입 추정. 실패 시 `swing/ballFlight:null` + `errorMessage`.
- `analysis/engine.js`: Node → Python 워커 호출, 실패 시 fallback 결과(`errorMessage`) 반환.

## 운영(PM2 예시)

```bash
pm2 start ecosystem.config.cjs --env production
pm2 save && pm2 startup
```

- `ecosystem.config.cjs`에서 `UPLOAD_DIR`, `DATA_DIR`를 운영 경로(`/home/ray/...`)로 지정.

## 한계/주의

- 프로토타입 수준: 공/클럽 검출 실패 시 `null`/신뢰도 낮은 값이 내려올 수 있음.
- 정확도 안정화를 위해 fps/FOV/ROI/거리 정보를 함께 제공하면 좋음.
- Job 큐/고도화된 ML 모델 연동은 추후 리팩토링 목표.
