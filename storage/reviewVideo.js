const fs = require('fs/promises');
const path = require('path');
const { createHash } = require('crypto');

// Playback copies only; analysis and labels always keep their original input.
function createReviewVideo({ cacheDir, runCommand }) {
  let active = null;
  const timingChecks = new Map();
  const signature = (stat) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  async function verifiedCopy(source, output, expectedTimes) {
    if (!expectedTimes) return output;
    if (!Array.isArray(expectedTimes) || expectedTimes.length < 4 || expectedTimes.length > 7200 || expectedTimes[0] !== 0
        || !expectedTimes.every((time, i) => Number.isFinite(time) && time >= 0 && time <= 30000 && (i === 0 || time > expectedTimes[i - 1]))) return source;
    try {
      const stat = await fs.stat(output);
      const clockHash = createHash('sha256').update(JSON.stringify(expectedTimes)).digest('hex');
      const key = `${output}:${signature(stat)}:${clockHash}`;
      if (!timingChecks.has(key)) {
        const work = (async () => {
          try {
            const {stdout} = await runCommand('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_frames',
              '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', output], {timeoutMs: 30_000});
            const frames = JSON.parse(stdout).frames;
            if (!Array.isArray(frames) || frames.length !== expectedTimes.length) return false;
            const times = frames.map((frame) => typeof frame?.best_effort_timestamp_time === 'string'
              && frame.best_effort_timestamp_time.trim() ? Number(frame.best_effort_timestamp_time) * 1000 : NaN);
            return Number.isFinite(times[0]) && times.every((time, i) => Number.isFinite(time)
              && Math.abs(time - times[0] - expectedTimes[i]) <= 1.1) && signature(await fs.stat(output)) === signature(stat);
          } catch { return false; }
        })();
        timingChecks.set(key, work);
        if (timingChecks.size > 32) timingChecks.delete(timingChecks.keys().next().value);
      }
      return await timingChecks.get(key) ? output : source;
    } catch { return source; }
  }
  return async function playbackPath(source, expectedTimes = null) {
    const stat = await fs.stat(source);
    const key = createHash('sha256').update(`${source}:${signature(stat)}:640-v1`).digest('hex');
    const output = path.join(cacheDir, `${key}.mp4`);
    try { if ((await fs.stat(output)).size > 0) return verifiedCopy(source, output, expectedTimes); } catch {}
    if (active) {
      if (active.key !== key) return source;
      const result = await active.promise;
      return result === source ? source : verifiedCopy(source, result, expectedTimes);
    }
    const promise = (async () => {
      const temporary = `${output}.part.mp4`;
      try {
        await fs.mkdir(cacheDir, { recursive: true });
        await runCommand('ffmpeg', ['-v', 'error', '-y', '-i', source,
          '-map', '0:v:0', '-map', '0:a?',
          '-vf', 'scale=w=min(640\\,iw):h=min(640\\,ih):force_original_aspect_ratio=decrease:force_divisible_by=2',
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p',
          '-threads', '2', '-fps_mode', 'passthrough', '-enc_time_base', '-1', '-g', '30',
          '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', temporary], { timeoutMs: 45000 });
        if (signature(await fs.stat(source)) !== signature(stat) || !(await fs.stat(temporary)).size) return source;
        await fs.rename(temporary, output);
        return output;
      } catch {
        return source;
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => {});
        active = null;
      }
    })();
    active = { key, promise };
    const result = await promise;
    return result === source ? source : verifiedCopy(source, result, expectedTimes);
  };
}
module.exports = { createReviewVideo };
