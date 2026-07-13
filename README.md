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
- 분석 서비스: `INFER_BASE_URL`(기본 `http://127.0.0.1:3002`)
- body bootstrap 서비스: `BODY_ANALYZER_BASE_URL`(기본 `http://127.0.0.1:3002`)
- 선택 NAS 아카이브: `NAS_ARCHIVE_URL`, `NAS_ARCHIVE_TOKEN` (둘 다 설정된 경우만 활성화)
- 헬스체크: `GET /health/ok.txt`
- 정적 자산: `client-dist/`를 자동 서빙하며 SPA fallback(`/index.html`)도 포함됨. 별도 프런트 빌드가 있다면 해당 폴더에 산출물 배치.

## 핵심 API 요약

- 업로드(+옵션 분석): `POST /api/upload` (form-data `video`, `?analyze=true`, `force=true`로 프리체크 무시)
- Hailo 메타 기반 분석: `POST /api/analyze/from-file` (`{ jobId, filename?, metaPath?, force? }`, `filename` 기본 `<jobId>.mp4`, `metaPath` 기본 `META_DIR/<jobId>.meta.json`, 상태 `pending|running|done|failed`)
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
- 백엔드는 `INFER_BASE_URL`의 `/v1/jobs`로 분석을 위임하며, `metaPath`는 그대로 전달됨(없으면 `META_DIR/<jobId>.meta.json`로 해석).
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
- 분석 스키마(현 버전): `hailo-infer`의 service7/fusion 결과를 우선 사용한다. 핵심 필드는 `events`, `metrics.tempo`, `metrics.shaftPlane`, `metrics.backswing`, `metrics.trackingQuality`, `metrics.body`, `metrics.club`, `metrics.fusion`, `coachSummary`, `coachFindings`, `confidence`, `progress`다.
- `coachFindings`는 객체 배열을 그대로 pass-through한다. 프론트가 `evidence`, `interpretation`, `action`, `drill`, `checkpoint`, `caution`, `confidence`, `theory`를 표시하므로, `pi_service`에서 finding 객체를 필드별로 재작성하거나 필터링하지 않는다.
- OpenCV 결과(`ballFlight/impact/swing`, `analysisVersion=opencv-v1`)는 레거시/폴백 경로로만 해석한다. 일부 값은 검출 실패 시 `null/unknown`.

## OpenCV 워커

- `analysis/opencv_worker.py`: 공 검출/임팩트 추정/궤적 계산 → 발사각/수평각/곡률/샷 타입 추정. 실패 시 `swing/ballFlight:null` + `errorMessage`.
- `analysis/engine.js`: Node → Python 워커 호출, 실패 시 fallback 결과(`errorMessage`) 반환.

## 운영(PM2 예시)

```bash
pm2 start ecosystem.config.cjs --env production
pm2 save && pm2 startup
```

- `ecosystem.config.cjs`에서 `UPLOAD_DIR`, `DATA_DIR`를 운영 경로(`/home/ray/...`)로 지정.

## NAS 아카이브 (선택)

Pi는 분석을 로컬에서 끝낸 뒤, terminal 상태(`done`, `failed`)의 원본 영상과 분석 cache/result/body/meta
artifact를 NAS storage API로 자동 비동기 전송한다. NAS 연결 또는 전송 실패는 분석 결과에 영향을 주지 않으며,
전송은 최대 3회 재시도한다. 전송 상태는 분석 cache에 영속화되고, Pi가 재시작되면 완료되지 않은 작업을
자동 재개한다. 최종 실패는 `POST /api/archive/:jobId/retry`로 다시 큐에 넣을 수 있다.

1. NAS에서 `nas-storage/` 내용을 `/volume1/hailo/compose`로 복사한다.
2. `.env.example`을 `.env`로 복사하고 강한 `ARCHIVE_TOKEN`을 설정한다. `STORAGE_BIND_HOST`는
   반드시 `127.0.0.1`로 유지한다.
3. root 권한으로 `docker compose --env-file .env -f compose.yml up -d --build`를 실행한다.
4. DSM의 Tailscale은 userspace networking 모드이므로, host IP에 Docker 포트를 bind하지 않는다.
   root 권한으로 아래 Serve 규칙을 한 번 등록한다. 이 규칙은 reboot 뒤에도 유지되며 NAS 외부 LAN에는
   포트를 열지 않고 tailnet에서만 raw TCP를 `127.0.0.1:18080`으로 전달한다.

```bash
/volume1/@appstore/Tailscale/bin/tailscale \
  --socket=/volume1/@appdata/Tailscale/tailscaled.sock \
  serve --bg --tcp=18080 tcp://127.0.0.1:18080
```

5. Pi 배포 환경에 다음 값을 설정한다. Tailscale 터널 구간은 암호화되고, API는 별도 Bearer token도
   검증한다.

```bash
NAS_ARCHIVE_URL=http://100.89.166.77:18080
NAS_ARCHIVE_TOKEN=<ARCHIVE_TOKEN과 동일한 값>
```

운영 배포는 GitHub Actions의 `NAS_ARCHIVE_URL`, `NAS_ARCHIVE_TOKEN` Actions secret을 PM2 기동 환경으로만
전달한다. 두 secret이 비어 있으면 아카이브는 비활성화되며 기존 분석은 그대로 동작한다.

아카이브는 NAS의 `/volume1/hailo/jobs/<jobId>/`에 파일과 `manifest.json`을 원자적으로 기록한다.
보관 결과는 Bearer token을 포함해 `GET /v1/jobs/<jobId>/manifest`,
`GET /v1/jobs/<jobId>/artifacts/<artifact>/<filename>`으로 읽을 수 있다. 파일명은 manifest의
`artifacts` 목록에서 확인한다.

Pi의 원본 영상이 먼저 정리된 job은 분석·메타만 보관되며 `nasArchive.videoStored: false`로 표시된다.
웹에서 영상을 삭제하면 Pi의 해당 job 분석 산출물과 NAS의 동일 job 보관본도 함께 삭제한다. 전체 학습
데이터 초기화는 GitHub Actions의 **Purge Learning Data**를 수동 실행하고 확인 문구
`PURGE_LEARNING_DATA`를 입력한다.

## 한계/주의

- 프로토타입 수준: 공/클럽 검출 실패 시 `null`/신뢰도 낮은 값이 내려올 수 있음.
- 정확도 안정화를 위해 fps/FOV/ROI/거리 정보를 함께 제공하면 좋음.
- Job 큐/고도화된 ML 모델 연동은 추후 리팩토링 목표.
