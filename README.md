# hailo-back
라즈베리파이에서 동작하는 **골프 스윙 업로드·분석 백엔드**입니다. 업로드/정적 서빙 + 간단한 OpenCV 기반 분석을 제공하며, 추후 Job/ML 파이프라인으로 확장 예정입니다.

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
- 헬스체크: `GET /health/ok.txt`

## 핵심 API 요약
- 업로드(+옵션 분석): `POST /api/upload` (form-data `video`, `?analyze=true`, `force=true`로 프리체크 무시)
- 기존 파일 분석: `POST /api/analyze/from-file` (`{ filename, force? }`, `.mp4/.mov` 지원, 내부 상태 `queued → running → succeeded/failed`)
- 분석 업로드(동일): `POST /api/analyze/upload`, `POST /api/analyze`
- 파일 목록(표준): `GET /api/files/detail` → `.mp4/.mov` + 상태/분석/에러 포함
- 샷/세션: `GET /api/shots`, `GET /api/shots/:id/analysis`, `GET /api/sessions`
- 정적 파일: `/uploads/:name`

## 파일 목록/상태 규약 (`GET /api/files/detail`)
- 응답: `{ ok: true, files: [{ filename, url, shotId, jobId, analyzed, status, size, modifiedAt, analysis, errorCode?, errorMessage? }] }`
- `status`: `not-analyzed | queued | running | succeeded | failed`
- `url`: URL 인코딩된 `/uploads/...` 제공 → 그대로 `<video src>`에 사용 (공백/한글/특수문자 안전)
- 확장자: `.mp4`, `.mov` 포함

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
