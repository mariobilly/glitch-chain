/** Minimal in-app modal (Electron has no window.prompt). `def === null` makes it a confirm. */
export function ask(title: string, def: string | null): Promise<string | null> {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "modal";
    wrap.innerHTML = `<form class="modal-box">
      <div class="modal-title"></div>
      ${def === null ? "" : '<input type="text" spellcheck="false">'}
      <div class="modal-actions"><button type="button" data-a="cancel">Cancel</button><button type="submit" class="primary">OK</button></div>
    </form>`;
    wrap.querySelector(".modal-title")!.textContent = title;
    const input = wrap.querySelector("input");
    if (input) input.value = def ?? "";
    const done = (v: string | null): void => {
      wrap.remove();
      resolve(v);
    };
    wrap.querySelector("form")!.onsubmit = (e) => {
      e.preventDefault();
      done(input ? input.value.trim() || null : "");
    };
    wrap.querySelector<HTMLButtonElement>("[data-a=cancel]")!.onclick = () =>
      done(null);
    wrap.onkeydown = (e) => {
      if (e.key === "Escape") done(null);
    };
    document.body.appendChild(wrap);
    (input ?? wrap.querySelector<HTMLButtonElement>(".primary"))!.focus();
    input?.select();
  });
}

let toastTimer = 0;
export function toast(msg: string, error = false, onClick?: () => void): void {
  let el = document.querySelector<HTMLDivElement>(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.toggle("error", error);
  el.classList.toggle("link", !!onClick);
  el.onclick = onClick ?? null;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(
    () => el!.classList.remove("show"),
    error ? 7000 : 4000,
  );
}

/** Modal with several buttons; resolves the index clicked, or -1 on Escape. The last button is the default. */
export function choose(
  title: string,
  detail: string,
  buttons: string[],
): Promise<number> {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "modal";
    wrap.innerHTML = `<div class="modal-box"><div class="modal-title"></div><div class="meta detail"></div><div class="modal-actions"></div></div>`;
    wrap.querySelector(".modal-title")!.textContent = title;
    wrap.querySelector(".detail")!.textContent = detail;
    const bar = wrap.querySelector(".modal-actions")!;
    const done = (i: number): void => {
      wrap.remove();
      resolve(i);
    };
    buttons.forEach((label, i) => {
      const b = document.createElement("button");
      b.textContent = label;
      if (i === buttons.length - 1) b.className = "primary";
      b.onclick = () => done(i);
      bar.appendChild(b);
    });
    wrap.tabIndex = -1;
    wrap.onkeydown = (e) => {
      if (e.key === "Escape") done(-1);
    };
    document.body.appendChild(wrap);
    (bar.lastElementChild as HTMLButtonElement).focus();
  });
}
