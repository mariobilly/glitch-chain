import type { Codec } from "../../../preload";
import { fmtTime } from "../Transport";

export interface RenderChoice {
  width: number;
  height: number;
  fps: number;
  codec: Codec;
  includeAudio: boolean;
  /** Output size multiplier relative to the preview size (1 or 2). */
  scale: number;
  /** Render now, add to the queue, or queue 9:16 + 1:1 + 16:9 versions. */
  action: "render" | "queue" | "social";
}

interface Opts {
  width: number;
  height: number;
  duration: number;
  audioLabel: string | null;
}

const scaleTo = (w: number, h: number, k: number): [number, number] => {
  const s = Math.min(k, 3840 / Math.max(w, h));
  return [Math.round((w * s) / 2) * 2, Math.round((h * s) / 2) * 2];
};

/** Settings modal. Resolves null on cancel. */
export function askRenderSettings(o: Opts): Promise<RenderChoice | null> {
  const [w2, h2] = scaleTo(o.width, o.height, 2);
  const res = [
    [o.width, o.height, `${o.width}×${o.height} (1×)`, 1],
    ...(w2 > o.width
      ? [
          [
            w2,
            h2,
            `${w2}×${h2} (${Math.max(w2, h2) >= 3840 ? "4K" : "2×"})`,
            w2 / o.width,
          ],
        ]
      : []),
  ] as [number, number, string, number][];
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "modal";
    wrap.innerHTML = `<form class="modal-box render-box">
      <div class="modal-title">Render video</div>
      <label>Resolution<select name="res">${res.map((r, i) => `<option value="${i}">${r[2]}</option>`).join("")}</select></label>
      <label>Frame rate<select name="fps"><option>24</option><option>25</option><option selected>30</option><option>50</option><option>60</option></select></label>
      <label>Format<select name="codec">
        <option value="h264">MP4 · H.264 (social, universal)</option>
        <option value="h265">MP4 · H.265 / HEVC (smaller files)</option>
        <option value="prores">MOV · ProRes 422 HQ (editing master)</option>
      </select></label>
      <label class="check"><input type="checkbox" name="audio" ${o.audioLabel ? "checked" : "disabled"}>
        Include audio <span class="meta">${o.audioLabel ?? "no audio loaded"}</span></label>
      <div class="meta">Length ${fmtTime(o.duration)} from the timeline · rendered frame by frame (not real-time)</div>
      <div class="modal-actions">
        <button type="button" data-a="cancel">Cancel</button>
        <span class="spacer"></span>
        <button type="submit" data-act="social" title="Queue 9:16, 1:1 and 16:9 versions with these settings">Social pack</button>
        <button type="submit" data-act="queue">Add to queue</button>
        <button type="submit" data-act="render" class="primary">Render…</button>
      </div>
    </form>`;
    const form = wrap.querySelector("form")!;
    const done = (v: RenderChoice | null): void => {
      wrap.remove();
      resolve(v);
    };
    form.onsubmit = (e) => {
      e.preventDefault();
      const f = new FormData(form);
      const r = res[Number(f.get("res"))];
      const act = ((e.submitter as HTMLButtonElement | null)?.dataset.act ??
        "render") as RenderChoice["action"];
      done({
        width: r[0],
        height: r[1],
        fps: Number(f.get("fps")),
        codec: f.get("codec") as Codec,
        includeAudio: f.get("audio") === "on",
        scale: r[3],
        action: act,
      });
    };
    wrap.querySelector<HTMLButtonElement>("[data-a=cancel]")!.onclick = () =>
      done(null);
    wrap.onkeydown = (e) => {
      if (e.key === "Escape") done(null);
    };
    document.body.appendChild(wrap);
    wrap.querySelector<HTMLButtonElement>(".primary")!.focus();
  });
}

/** Progress modal with cancel. */
export function showRenderProgress(
  onCancel: () => void,
  title = "Rendering…",
): { update: (frame: number, total: number) => void; close: () => void } {
  const wrap = document.createElement("div");
  wrap.className = "modal";
  wrap.innerHTML = `<div class="modal-box render-box">
    <div class="modal-title"></div>
    <div class="bar"><div></div></div>
    <div class="meta stat">Preparing…</div>
    <div class="modal-actions"><button type="button">Cancel</button></div>
  </div>`;
  wrap.querySelector(".modal-title")!.textContent = title;
  wrap.querySelector("button")!.onclick = onCancel;
  document.body.appendChild(wrap);
  const bar = wrap.querySelector<HTMLDivElement>(".bar div")!;
  const stat = wrap.querySelector<HTMLDivElement>(".stat")!;
  const t0 = performance.now();
  return {
    update(frame, total) {
      const el = (performance.now() - t0) / 1000;
      const fps = frame / Math.max(el, 1e-3);
      bar.style.width = `${(frame / total) * 100}%`;
      stat.textContent = `Frame ${frame} / ${total} · ${fps.toFixed(1)} fps · ETA ${fmtTime((total - frame) / Math.max(fps, 1e-3))}`;
    },
    close: () => wrap.remove(),
  };
}
