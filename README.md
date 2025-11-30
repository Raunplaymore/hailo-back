# hailo-back (Raspberry Pi Swing Upload Server)

간단한 Express 백엔드로 스윙 영상을 업로드하고 정적 프론트(`client-dist`)를 제공하는 서비스입니다. 기본 포트는 `3000`입니다.

## 실행
```bash
npm install
node server.js
# 또는 UPLOAD_DIR=/home/pi/uploads node server.js  # 라즈베리 파이 경로 사용 시
```

- 기본 업로드 경로: `./uploads` (없으면 자동 생성). `UPLOAD_DIR` 환경변수로 변경 가능.
- 프론트 빌드가 있다면 `http://localhost:3000/`에서 확인할 수 있습니다.

## API
- `POST /api/upload` : `multipart/form-data` 필드명 `video` 로 업로드. 응답 `{ ok: true, file: "<저장파일명>" }`
- `GET /api/files` : 업로드된 파일 목록 배열 반환

## PM2 운영
- 전역 설치: `npm i -g pm2`
- 시작: `pm2 start ecosystem.config.cjs --env production`
- 부팅 자동시작: `pm2 save && pm2 startup`
- 설정: `ecosystem.config.cjs`에서 `UPLOAD_DIR` 기본값(로컬 `./uploads`), production(`env_production`)에서 라즈베리 파이 경로 `/home/pi/uploads`를 사용하도록 되어 있습니다.

## 서비스 등록(라즈베리 파이, systemd 사용 시)
- `systemd/swing-server.service`를 `/etc/systemd/system/`에 설치 후 `sudo systemctl enable --now swing-server.service`
- 핫스팟 감지 자동 시작: `systemd/hotspot-watch.service`, `systemd/hotspot-watch.timer`, `scripts/check-hotspot-and-start.sh` 참고
