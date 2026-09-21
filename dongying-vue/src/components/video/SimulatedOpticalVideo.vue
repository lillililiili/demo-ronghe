<script setup>
import { onMounted, onUnmounted, ref } from 'vue';
const props = defineProps({ subtype: String });
const host = ref(null), video = ref(null), failed = ref(false), paused = ref(false), expanded = ref(false);
const escape = event => { if (event.key === 'Escape') expanded.value = false; };
let animation, stream, disposed = false;
onMounted(() => {
  document.addEventListener('keydown', escape);
  const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
  const ctx = canvas.getContext('2d');
  if (!ctx || !canvas.captureStream) { failed.value = true; return; }
  const scene = new Image(); scene.src = '/assets/img/login/coastal-dawn.png';
  const start = performance.now();
  function frame(now) {
    if (disposed) return;
    const t = (now - start) / 1000;
    ctx.fillStyle = '#233946'; ctx.fillRect(0, 0, 640, 360);
    if (scene.complete && scene.naturalWidth) {
      const scale = Math.max(640 / scene.naturalWidth, 360 / scene.naturalHeight) * 1.12;
      ctx.drawImage(scene, (640 - scene.naturalWidth * scale) / 2 + Math.sin(t / 6) * 12, (360 - scene.naturalHeight * scale) / 2, scene.naturalWidth * scale, scene.naturalHeight * scale);
    }
    const x = 320 + Math.sin(t / 3) * 90, y = 150 + Math.cos(t / 4) * 28;
    ctx.strokeStyle = '#14232d'; ctx.lineWidth = 2;
    if (props.subtype === 'BALLOON') {
      ctx.fillStyle = '#e4d6b4'; ctx.beginPath(); ctx.ellipse(x, y, 12, 16, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.moveTo(x, y + 16); ctx.lineTo(x - 5, y + 39); ctx.stroke();
    } else if (props.subtype === 'UAV') {
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(x - 19, y - 10); ctx.lineTo(x + 19, y + 10);
      ctx.moveTo(x - 19, y + 10); ctx.lineTo(x + 19, y - 10); ctx.stroke();
      for (const [dx, dy] of [[-19,-10], [19,10], [-19,10], [19,-10]]) {
        ctx.beginPath(); ctx.ellipse(x + dx, y + dy, 11, 4, 0, 0, Math.PI * 2); ctx.stroke();
      }
    } else {
      for (let i = 0; i < 7; i++) {
        const bx = x + (i % 4) * 16 - 24, by = y + Math.floor(i / 4) * 16;
        const wing = Math.sin(t * 7 + i) * 5;
        ctx.beginPath(); ctx.moveTo(bx - 6, by + wing); ctx.lineTo(bx, by); ctx.lineTo(bx + 6, by + wing); ctx.stroke();
      }
    }
    ctx.strokeStyle = '#7aefba'; ctx.lineWidth = 1; ctx.strokeRect(x - 48, y - 33, 96, 78);
    ctx.beginPath(); ctx.moveTo(305, 180); ctx.lineTo(335, 180); ctx.moveTo(320, 165); ctx.lineTo(320, 195); ctx.stroke();
    ctx.fillStyle = 'rgba(5,15,24,.8)'; ctx.fillRect(0, 0, 640, 34); ctx.fillRect(0, 329, 640, 31);
    ctx.fillStyle = '#ffda91'; ctx.font = 'bold 16px sans-serif'; ctx.fillText('模拟视频演示 · 非设备实拍', 14, 23);
    ctx.fillStyle = '#dcecf4'; ctx.font = '13px sans-serif'; ctx.fillText('演示光电视角', 14, 349); ctx.fillText(new Date().toLocaleTimeString(), 545, 349);
    animation = requestAnimationFrame(frame);
  }
  animation = requestAnimationFrame(frame);
  stream = canvas.captureStream(20); video.value.srcObject = stream;
  video.value.play().catch(() => { if (!disposed) paused.value = true; });
});
async function toggle() {
  if (!video.value) return;
  if (video.value.paused) { try { await video.value.play(); paused.value = false; } catch { failed.value = true; } }
  else { video.value.pause(); paused.value = true; }
}
function fullscreen() { expanded.value = !expanded.value; }
onUnmounted(() => { document.removeEventListener('keydown', escape); disposed = true; cancelAnimationFrame(animation); stream?.getTracks().forEach(t => t.stop()); if (video.value) video.value.srcObject = null; });
</script>
<template>
  <Teleport to="body" :disabled="!expanded">
  <div ref="host" class="simulated-video" :class="{ expanded }">
    <video ref="video" muted playsinline aria-label="模拟光电视频，非设备实拍" />
    <p v-if="failed" role="alert">当前浏览器无法播放模拟视频。</p>
    <div class="video-controls"><span>模拟画面 · 不连接现场设备</span><button class="btn" :disabled="failed" @click="toggle">{{ paused ? '播放' : '暂停' }}</button><button class="btn" :disabled="failed" :aria-expanded="expanded" @click="fullscreen">{{ expanded ? '退出全屏' : '全屏' }}</button></div>
  </div>
  </Teleport>
</template>
<style scoped>
.simulated-video { background:#08121c; border:1px solid var(--border); border-radius:8px; overflow:hidden; }
video { display:block; width:100%; aspect-ratio:16/9; object-fit:contain; }
.video-controls { display:flex; flex-wrap:wrap; align-items:center; gap:6px; padding:8px; }
.video-controls span { flex:1; font-size:11px; color:var(--txt-3); }
.video-controls button { font-size:11px; padding:4px 8px; }
.simulated-video.expanded { position:fixed; inset:0; z-index:10000; display:flex; flex-direction:column; justify-content:center; border-radius:0; }
.simulated-video.expanded video { max-height:calc(100vh - 60px); }
</style>
