const fs = require('fs/promises');
const path = require('path');
const { createHash } = require('crypto');

// Playback copies only; analysis and labels always keep their original input.
function createReviewVideo({ cacheDir, runCommand }) {
  let active = null;
  const signature = (stat) => `${stat.size}:${stat.mtimeMs}`;
  return async function playbackPath(source) {
    const stat = await fs.stat(source);
    const key = createHash('sha256').update(`${source}:${signature(stat)}:640-v1`).digest('hex');
    const output = path.join(cacheDir, `${key}.mp4`);
    try { if ((await fs.stat(output)).size > 0) return output; } catch {}
    if (active) return active.key === key ? active.promise : source;
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
    return promise;
  };
}
module.exports = { createReviewVideo };
