import { contextBridge, ipcRenderer, webUtils } from 'electron'

export type Codec = 'h264' | 'h265' | 'prores'

const api = {
  pathForFile: (f: File): string => {
    try {
      return webUtils.getPathForFile(f)
    } catch {
      return ''
    }
  },
  saveFile: (name: string, filters: { name: string; extensions: string[] }[], data: ArrayBuffer): Promise<string | null> =>
    ipcRenderer.invoke('save-file', name, filters, data),

  renderChoose: (defaultName: string, codec: Codec): Promise<string | null> => ipcRenderer.invoke('render:choose', defaultName, codec),
  renderStart: (o: {
    out: string
    width: number
    height: number
    fps: number
    duration: number
    codec: Codec
    audioPath?: string
  }): Promise<boolean> => ipcRenderer.invoke('render:start', o),
  renderFrame: (px: Uint8Array): Promise<void> => ipcRenderer.invoke('render:frame', px),
  renderFinish: (): Promise<string> => ipcRenderer.invoke('render:finish'),
  renderCancel: (): Promise<void> => ipcRenderer.invoke('render:cancel'),

  listPresets: (): Promise<unknown[]> => ipcRenderer.invoke('presets:list'),
  exportPreset: (name: string, data: unknown): Promise<string | null> => ipcRenderer.invoke('preset:export', name, data),
  importPresets: (): Promise<unknown[]> => ipcRenderer.invoke('preset:import'),
  chooseFolder: (title: string): Promise<string | null> => ipcRenderer.invoke('choose-folder', title),
  uniquePath: (dir: string, name: string, ext: string): Promise<string> => ipcRenderer.invoke('unique-path', dir, name, ext),
  savePreset: (name: string, data: unknown): Promise<boolean> => ipcRenderer.invoke('presets:save', name, data),
  deletePreset: (name: string): Promise<boolean> => ipcRenderer.invoke('presets:delete', name),
  readFile: (p: string): Promise<{ name: string; data: ArrayBuffer }> => ipcRenderer.invoke('read-file', p),
  autoload: (): Promise<{ load: string; music: string; preset: string; render: string; renderSpec: string; project: string; autosaveMs: number; welcome: boolean }> =>
    ipcRenderer.invoke('autoload'),
  reveal: (p: string): Promise<void> => ipcRenderer.invoke('reveal', p),
  saveTrack: (meta: Record<string, unknown> & { id: string; frameCount: number }, frames: (ArrayBuffer | null)[]): Promise<boolean> =>
    ipcRenderer.invoke('tracks:save', meta, frames),
  listTracks: (): Promise<unknown[]> => ipcRenderer.invoke('tracks:list'),
  loadTrack: (id: string, frameCount: number): Promise<(ArrayBuffer | null)[]> => ipcRenderer.invoke('tracks:load', id, frameCount),
  deleteTrack: (id: string): Promise<boolean> => ipcRenderer.invoke('tracks:delete', id),
  quit: (): Promise<void> => ipcRenderer.invoke('quit'),

  // projects
  saveProject: (path: string | null, suggested: string, json: string): Promise<string | null> =>
    ipcRenderer.invoke('project:save', path, suggested, json),
  openProject: (path?: string): Promise<{ path: string; text: string } | null> => ipcRenderer.invoke('project:open', path),
  recentProjects: (): Promise<{ path: string; exists: boolean }[]> => ipcRenderer.invoke('project:recent'),
  autosave: (json: string): Promise<void> => ipcRenderer.invoke('project:autosave', json),
  readAutosave: (): Promise<{ text: string; time: number } | null> => ipcRenderer.invoke('project:autosave-read'),
  clearAutosave: (): Promise<void> => ipcRenderer.invoke('project:autosave-clear'),
  fileExists: (p: string): Promise<boolean> => ipcRenderer.invoke('file:exists', p),
  chooseFile: (filters: { name: string; extensions: string[] }[]): Promise<string | null> => ipcRenderer.invoke('file:choose', filters),
  locateFile: (title: string, name: string, kind: 'media' | 'audio'): Promise<string | null> => ipcRenderer.invoke('file:locate', title, name, kind),
  setTitle: (t: string): Promise<void> => ipcRenderer.invoke('app:title', t),
  onCloseRequest: (fn: () => void): void => {
    ipcRenderer.on('app:close-request', () => fn())
  },
  ackClose: (): Promise<void> => ipcRenderer.invoke('app:close-ack'),
  closeNow: (close: boolean): Promise<void> => ipcRenderer.invoke('app:close-now', close),
  onOpenProject: (fn: (path: string) => void): void => {
    ipcRenderer.on('app:open-project', (_e, p: string) => fn(p))
  }
}

export type Api = typeof api
contextBridge.exposeInMainWorld('api', api)
