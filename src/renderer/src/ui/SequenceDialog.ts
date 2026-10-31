import { CURRENT, type Sequence } from "../sequence";

/** Edits the sequence in place; `onChange` fires on every edit so the preview updates live. */
export function openSequenceDialog(
  seq: Sequence,
  presetNames: string[],
  hasBeats: boolean,
  onChange: () => void,
): void {
  const wrap = document.createElement("div");
  wrap.className = "modal";
  wrap.innerHTML = `<div class="modal-box seq-box">
    <div class="browser-head"><div class="modal-title">Preset sequence</div><button data-a="close">✕</button></div>
    <label class="check"><input type="checkbox" name="on"> Cut between presets on the timeline</label>
    <div class="seq-row">
      <label>Switch every <input type="number" name="every" min="0.25" step="0.25"></label>
      <select name="mode"><option value="beats">beats</option><option value="bars">bars</option><option value="seconds">seconds</option></select>
      <select name="order"><option value="loop">in order</option><option value="random">random</option></select>
    </div>
    <div class="meta seq-hint"></div>
    <div class="seq-list"></div>
    <div class="seq-row"><select name="add"></select><button data-a="add">＋ Add</button></div>
    <div class="modal-actions"><button type="button" class="primary" data-a="close">Done</button></div>
  </div>`;
  const q = <T extends HTMLElement>(sel: string): T =>
    wrap.querySelector(sel) as T;
  const on = q<HTMLInputElement>("[name=on]");
  const every = q<HTMLInputElement>("[name=every]");
  const mode = q<HTMLSelectElement>("[name=mode]");
  const order = q<HTMLSelectElement>("[name=order]");
  const add = q<HTMLSelectElement>("[name=add]");
  add.innerHTML = [CURRENT, ...presetNames]
    .map((n) => `<option>${n.replace(/</g, "&lt;")}</option>`)
    .join("");

  const hint = (): void => {
    q(".seq-hint").textContent =
      seq.mode === "seconds"
        ? "Cuts at fixed time intervals."
        : hasBeats
          ? seq.mode === "bars"
            ? "Cuts land on the first beat of every bar (counted from the music's first bar)."
            : "Cuts land on beats, counted from the first beat of a bar."
          : "No audio loaded: 120 BPM (4 beats per bar) is assumed until you add music.";
  };
  const renderList = (): void => {
    const list = q(".seq-list");
    list.innerHTML = seq.items.length
      ? ""
      : '<div class="meta">Add two or more presets.</div>';
    seq.items.forEach((name, i) => {
      const row = document.createElement("div");
      row.className = "seq-item";
      row.innerHTML = `<span class="idx">${String(i + 1).padStart(2, "0")}</span><span class="name"></span>
        <button data-m="up" title="Move up">↑</button><button data-m="down" title="Move down">↓</button><button data-m="del" title="Remove">✕</button>`;
      row.querySelector(".name")!.textContent = name;
      row.querySelectorAll("button").forEach((b) => {
        b.onclick = () => {
          const m = b.dataset.m;
          if (m === "del") seq.items.splice(i, 1);
          else {
            const j = m === "up" ? i - 1 : i + 1;
            if (j < 0 || j >= seq.items.length) return;
            [seq.items[i], seq.items[j]] = [seq.items[j], seq.items[i]];
          }
          changed();
        };
      });
      list.appendChild(row);
    });
  };
  const changed = (): void => {
    renderList();
    hint();
    onChange();
  };

  on.checked = seq.on;
  every.value = String(seq.every);
  mode.value = seq.mode;
  order.value = seq.order;
  on.onchange = () => {
    seq.on = on.checked;
    changed();
  };
  every.onchange = () => {
    seq.every = Math.max(0.25, Number(every.value) || 4);
    changed();
  };
  mode.onchange = () => {
    seq.mode = mode.value as Sequence["mode"];
    changed();
  };
  order.onchange = () => {
    seq.order = order.value as Sequence["order"];
    changed();
  };
  q<HTMLButtonElement>("[data-a=add]").onclick = () => {
    seq.items.push(add.value);
    if (seq.items.length >= 2) seq.on = on.checked = true;
    changed();
  };
  const close = (): void => wrap.remove();
  wrap
    .querySelectorAll<HTMLButtonElement>("[data-a=close]")
    .forEach((b) => (b.onclick = close));
  wrap.tabIndex = -1;
  wrap.onkeydown = (e) => {
    if (e.key === "Escape") close();
  };
  document.body.appendChild(wrap);
  wrap.focus();
  renderList();
  hint();
}
