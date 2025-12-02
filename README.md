# hailo-back (Raspberry Pi Swing Upload Server)

간단한 Express 백엔드로 스윙 영상을 업로드하고 정적 프론트(`client-dist`)를 제공하는 서비스입니다. 기본 포트는 `3000`입니다.

## 실행

```bash
npm install
node server.js
# 또는 UPLOAD_DIR=/home/ray/uploads node server.js  # 라즈베리 파이 경로 사용 시
```

- 기본 업로드 경로: `./uploads` (없으면 자동 생성). `UPLOAD_DIR` 환경변수로 변경 가능.
- 프론트 빌드가 있다면 `http://localhost:3000/`에서 확인할 수 있습니다.

## API

- `POST /api/upload` : `multipart/form-data` 필드명 `video` 로 업로드. 응답 `{ ok: true, file: "<저장파일명>" }`
- `GET /api/files` : 업로드된 파일 목록 배열 반환
- `DELETE /api/files/:name` : 파일 삭제. 경로 이스케이프 방지 적용.
- `GET /uploads/:name` : 업로드된 영상 정적 제공 (존재하지 않으면 404)
- 분석/샷 관리(스펙 초안):
  - `POST /analyze/upload` : 업로드와 동시에 분석 실행. 응답에 샷/분석 JSON 포함.
  - `POST /shots` : 카메라 등 외부 파이프라인에서 메타데이터 기반 샷 등록.
  - `GET /sessions` : 세션 목록 조회.
  - `GET /sessions/{id}` : 세션 상세+샷 목록.
  - `GET /shots/{id}/analysis` : 샷 분석 결과 반환.
  - 분석 스키마: 스윙/볼 플라이트/샷 타입/코치 코멘트 포함. 현재는 스텁 값이며, 향후 OpenCV/ML 기반 엔진으로 교체 가능.

## PM2 운영

- 전역 설치: `npm i -g pm2`
- 시작: `pm2 start ecosystem.config.cjs --env production`
- 부팅 자동시작: `pm2 save && pm2 startup`
- 설정: `ecosystem.config.cjs`에서 `UPLOAD_DIR` 기본값(로컬 `./uploads`), production(`env_production`)에서 라즈베리 파이 경로 `/home/pi/uploads`를 사용하도록 되어 있습니다.
