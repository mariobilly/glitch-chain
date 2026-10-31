/** First-run / on-demand welcome screen: quick starts, recent projects and a short how-it-works. */
export interface WelcomeActions {
  openMedia: () => void;
  camera: () => void;
  openProject: (path?: string) => void;
  browseLooks: () => void;
  recent: () => Promise<{ path: string; exists: boolean }[]>;
}

const KEY = "glitch.welcome";
let current: HTMLDivElement | null = null;

/** Whether the user wants the welcome screen at startup (default yes). */
export function welcomeAtStartup(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

export function closeWelcome(): void {
  current?.remove();
  current = null;
}

export async function showWelcome(a: WelcomeActions): Promise<void> {
  closeWelcome();
  const wrap = document.createElement("div");
  wrap.className = "modal welcome";
  wrap.innerHTML = `<div class="modal-box welcome-box">
    <div class="welcome-head">
      <div class="logo">GLITCH<b>CHAIN</b></div>
      <div class="meta">Real-time analog glitch, AI masks and depth. Everything runs on this computer.</div>
    </div>
    <div class="welcome-cols">
      <div class="welcome-start">
        <div class="welcome-label">Start</div>
        <button data-a="open" class="primary big">Open image or video<span>Ctrl+O · or drop a file on the preview</span></button>
        <button data-a="camera" class="big">Use the camera<span>Live webcam input</span></button>
        <button data-a="project" class="big">Open project…<span>A saved .glitch file</span></button>
        <button data-a="looks" class="big">Browse looks<span>Every preset, previewed on your image</span></button>
        <div class="welcome-label recent-label" hidden>Recent projects</div>
        <div class="welcome-recent"></div>
      </div>
      <div class="welcome-how">
        <div class="welcome-label">How it works</div>
        <ol>
          <li><b>Open</b> a photo or a video.</li>
          <li><b>Pick a look</b> from the presets, or stack effects in the chain on the right. Drag cards to reorder them.</li>
          <li><b>Mask</b> any effect to a face, hands, a person, a picked object (AI) or a depth range.</li>
          <li><b>Layer</b> several clips with blend modes, and add a LUT and film grain to finish.</li>
          <li><b>Render</b> a frame-exact MP4 or ProRes with audio, and save everything as a project.</li>
        </ol>
        <div class="welcome-label">Handy keys</div>
        <div class="welcome-keys">
          <span><kbd>Space</kbd> play</span><span><kbd>B</kbd> hold for original</span><span><kbd>Ctrl Z</kbd> undo</span>
          <span><kbd>Ctrl S</kbd> save</span><span><kbd>Ctrl R</kbd> render</span>
        </div>
      </div>
    </div>
    <div class="modal-actions">
      <label class="check"><input type="checkbox" data-a="startup"> Show at startup</label>
      <span class="spacer"></span>
      <button data-a="close">Close</button>
    </div>
  </div>`;
  const $ = <T extends HTMLElement>(s: string): T => wrap.querySelector<T>(s)!;
  const startup = $<HTMLInputElement>("[data-a=startup]");
  startup.checked = welcomeAtStartup();
  startup.onchange = () => {
    try {
      localStorage.setItem(KEY, startup.checked ? "on" : "off");
    } catch {
      /* no storage: the choice just isn't remembered */
    }
  };
  const act = (fn: () => void) => () => {
    closeWelcome();
    fn();
  };
  $("[data-a=open]").onclick = act(a.openMedia);
  $("[data-a=camera]").onclick = act(a.camera);
  $("[data-a=project]").onclick = act(() => a.openProject());
  $("[data-a=looks]").onclick = act(a.browseLooks);
  $("[data-a=close]").onclick = closeWelcome;
  wrap.onclick = (e) => {
    if (e.target === wrap) closeWelcome();
  };
  wrap.onkeydown = (e) => {
    if (e.key === "Escape") closeWelcome();
  };
  current = wrap;
  document.body.appendChild(wrap);
  $<HTMLButtonElement>("[data-a=open]").focus();

  const recent = (await a.recent().catch(() => []))
    .filter((r) => r.exists)
    .slice(0, 5);
  if (current !== wrap || !recent.length) return;
  $(".recent-label").hidden = false;
  for (const r of recent) {
    const b = document.createElement("button");
    b.className = "recent";
    b.title = r.path;
    b.textContent = r.path
      .split(/[\\/]/)
      .pop()!
      .replace(/\.glitch$/i, "");
    b.onclick = act(() => a.openProject(r.path));
    $(".welcome-recent").appendChild(b);
  }
}
