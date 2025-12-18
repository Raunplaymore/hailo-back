# hailo-back
(Raspberry Pi Swing Upload & Analysis Server)

라즈베리파이에서 동작하는 **골프 스윙 영상 업로드/기본 분석 백엔드**입니다. 현재는 업로드와 간단한 OpenCV 기반 분석만 제공합니다. 향후에는 **비동기 Job 기반 분석 서버**로 확장할 계획입니다.

## 현재 상태 vs. 계획
- **현재(AS-IS)**: 업로드 수신, 정적 프론트 서빙, 간단한 분석(볼 발사각/방향·구질 추정, 모션 휴리스틱 기반 스윙 지표).
- **계획(TO-BE)**: 업로드 → 분석 Job 생성/상태 관리, 안정적인 OpenCV/ML 파이프라인 연결, 스윙 이벤트/템포/클럽 트래킹 결과 제공.

분석 정확도는 제한적입니다. 공/클럽 검출이 실패하거나 파라미터가 맞지 않으면 `null` 또는 신뢰도 낮은 값이 내려올 수 있습니다.

## 실행
```bash
npm install
node server.js
# 또는 UPLOAD_DIR=/home/ray/uploads node server.js
```
- 기본 포트: `3000`
- 기본 업로드 경로: `./uploads` (없으면 자동 생성). `UPLOAD_DIR` 환경변수로 변경 가능.
- 샷/세션 저장 경로: 기본은 `./data`이며, 운영에서는 `DATA_DIR=/home/ray/data` 같은 외부 경로 사용을 권장합니다(배포 시 릴리즈 교체로 데이터가 사라지는 것을 방지).
- 헬스 체크: `GET /health/ok.txt`
- 프론트 빌드가 있으면 `http://localhost:3000/`에서 접근.

## 주요 API
- `POST /api/upload`  
  - `multipart/form-data` 필드명 `video`  
  - `?analyze=true`(query/body)로 업로드+분석을 한 번에 수행, 응답에 `shot`/`analysis` 포함  
  - `force=true`(query/body)면 프리체크 결과와 무관하게 분석 진행
  - 분석 옵션(선택): `fps`, `roi`([x,y,w,h]), `cam_distance`, `cam_height`, `h_fov`, `v_fov`, `impact_frame`, `club`, `track_frames`
- `POST /api/analyze/upload` : 업로드+분석 (동일 흐름)
- `POST /api/analyze/from-file` : 업로드 디렉토리의 기존 `.mp4`를 재업로드 없이 분석 트리거 (`{ filename, force? }`)
- `GET /api/files/detail` : 업로드 디렉토리의 `.mp4` 목록 + 분석 여부/상태(프론트 표준)
- `GET /api/files` : (레거시) 저장된 샷 목록 기반 엔트리
- `DELETE /api/files/:name` : 파일/샷/세션 메타 삭제
- `GET /uploads/:name` : 업로드된 영상 정적 제공
- 샷/세션:
  - `GET /api/shots` : 샷 목록(+분석)
  - `GET /api/shots/:id/analysis` : 샷 ID 또는 파일명으로 분석 조회 (없으면 `analysis:null`)
  - `GET /api/sessions`, `GET /api/sessions/:id`

## 파일 목록/상태 (프론트 표준)
- `GET /api/files/detail`
  - 응답: `{ ok: true, files: [{ filename, url, shotId, jobId, analyzed, status, size, modifiedAt, analysis, errorCode?, errorMessage? }] }`
  - `status`: `not-analyzed | queued | running | succeeded | failed`
  - `analyzed`: `status === "succeeded"`일 때 `true`
  - `url`은 URL 인코딩된 경로를 내려주므로, 프론트는 `filename` 대신 `url`을 그대로 재생에 사용 권장
  - 확장자: `.mp4`, `.mov`를 목록에 포함

## 프리체크 Abort (NOT_SWING)
- 목적: 스윙 영상이 아닌 경우(정지/대기/오촬영 등) 무거운 분석을 돌리기 전에 조기 중단
- 동작:
  - 프리체크 실패 시 `status="failed"`로 저장하고 `analysis.errorCode="NOT_SWING"` + 사용자용 `analysis.errorMessage` 반환
  - `force=true`면 프리체크를 무시하고 분석을 강제로 진행

## iPhone `.mov` 업로드/분석
- iPhone에서 업로드되는 영상은 `.mov`(HEVC/H.264)일 수 있습니다.
- 목록: `.mov`도 `GET /api/files/detail`에 포함됩니다.
- 분석: `.mov` 분석을 위해 서버가 필요 시 `.mp4`로 리먹스/트랜스코딩(ffmpeg)하여 분석할 수 있습니다.
  - 변환/디코딩 실패 시 `status="failed"` + `errorCode="DECODE_FAILED"`로 구분합니다.

## 분석 스키마 (현 버전)
- `ballFlight` / `impact`  
  - `vertical_launch_angle`, `horizontal_launch_direction`, `spin_bias`(draw/fade/neutral), `side_curve_intensity`, `shot_type` 등  
  - 일부 값은 검출 실패 시 `null`/`unknown`
- `swing`  
  - 모션 휴리스틱 기반 추정: `club_path_angle`, `on_plane_ratio`, `tempo_ratio` 등 (검출 실패 시 null 가능)
- `coach_summary`  
  - 임팩트 프레임, 추적 포인트 수, 계산된 각도/구질 등 텍스트

## OpenCV 워커
- `analysis/opencv_worker.py`  
  - 영상에서 공을 검출/임팩트 추정/궤적 계산 → 발사각/수평각/곡률/샷 타입 추정  
  - 스윙 지표는 모션 휴리스틱으로 채움(정확도 제한). 실패 시 `swing/ballFlight:null` + `errorMessage`를 포함할 수 있음.
- `analysis/engine.js`  
  - Node → Python 워커 호출, 실패 시 `errorMessage` 포함한 fallback 결과 반환.

## PM2 운영
- 전역 설치: `npm i -g pm2`
- 시작: `pm2 start ecosystem.config.cjs --env production`
- 부팅 자동시작: `pm2 save && pm2 startup`
- 설정: `UPLOAD_DIR`는 config/env_production에서 조정 가능.

## 한계 및 주의
- 분석 결과는 프로토타입 수준이며, 공/클럽 추적 실패 시 `null`이 내려옵니다.
- 정확한 fps/FOV/ROI/거리 정보를 함께 주면 안정도가 높아집니다.
- Job 큐/안정적인 ML 모델 연동은 추후 리팩토링 목표입니다.
