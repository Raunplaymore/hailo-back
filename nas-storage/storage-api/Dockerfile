FROM node:20-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app
COPY server.js library.js ./
EXPOSE 8080
CMD ["node", "server.js"]
