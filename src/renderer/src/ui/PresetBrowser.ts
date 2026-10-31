import type { Preset } from "../presets";

export interface PresetGroup {
  title: string;
  presets: Preset[];
}

/**
 * Grid of presets with thumbnails rendered from the current source. `thumb` renders one preset
 * (synchronously, on the GPU); thumbnails are filled in one per frame so the modal opens instantly.
 */
export function openPresetBrowser(
  groups: PresetGroup[],
  thumb: (p: Preset) => HTMLCanvasElement,
  onPick: (p: Preset) => void,
): void {
  const wrap = document.createElement("div");
  wrap.className = "modal";
  wrap.innerHTML = `<div class="modal-box browser">
    <div class="browser-head"><div class="modal-title">Presets</div><span class="meta">previewed on your current source</span><button data-a="close">✕</button></div>
    <div class="browser-body"></div>
  </div>`;
  const body = wrap.querySelector<HTMLDivElement>(".browser-body")!;
  const queue: [Preset, HTMLDivElement][] = [];
  for (const g of groups) {
    if (!g.presets.length) continue;
    const h = document.createElement("div");
    h.className = "browser-group";
    h.textContent = g.title;
    body.appendChild(h);
    const grid = document.createElement("div");
    grid.className = "browser-grid";
    for (const p of g.presets) {
      const card = document.createElement("button");
      card.className = "preset-card";
      card.title = p.name;
      card.innerHTML = `<div class="thumb"></div><span></span>`;
      card.querySelector("span")!.textContent = p.name;
      card.onclick = () => {
        close();
        onPick(p);
      };
      grid.appendChild(card);
      queue.push([p, card.querySelector<HTMLDivElement>(".thumb")!]);
    }
    body.appendChild(grid);
  }
  let open = true;
  const close = (): void => {
    open = false;
    wrap.remove();
  };
  wrap.querySelector<HTMLButtonElement>("[data-a=close]")!.onclick = close;
  wrap.onclick = (e) => {
    if (e.target === wrap) close();
  };
  wrap.tabIndex = -1;
  wrap.onkeydown = (e) => {
    if (e.key === "Escape") close();
  };
  document.body.appendChild(wrap);
  wrap.focus();

  const next = (): void => {
    const item = queue.shift();
    if (!item || !open) return;
    try {
      item[1].appendChild(thumb(item[0]));
    } catch {
      item[1].classList.add("failed");
    }
    requestAnimationFrame(next);
  };
  requestAnimationFrame(next);
}
