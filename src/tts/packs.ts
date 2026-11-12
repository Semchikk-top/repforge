// Подготовка озвучки: фразы собираются на сервере (Fish), файлы скачиваются в память устройства.
// Идемпотентно: уже готовые и лежащие локально фразы пропускаются, прерванную сборку можно запустить снова.
// Всё это происходит только по кнопке или при построении маршрута. Во время записи сетевых вызовов нет.

import type { PlannedRoute, Settings } from '../domain/types';
import { platform } from '../platform';
import type { AudioStoreApi } from '../platform/types';
import { fetchAudio, getTtsConfig, streamPack, type PackEvent, type TtsConfig } from './api';
import { manifest as sharedManifest, normalizeText, paramsHashOf, textKey, type Manifest } from './cache';
import { routeTexts, staticTexts } from './classify';
import { spellNumbers } from './ruNumbers';

export const BATCH = 100; // фраз за один запрос к серверу (его предел — 200)

export interface PackProgress { done: number; total: number; failed: number }
export interface PackResult { ok: number; failed: number; skipped: number; total: number; aborted: boolean; fatal?: string }

export interface PackDeps {
  store: AudioStoreApi;
  manifest: Manifest;
  getConfig: () => Promise<TtsConfig>;
  stream: (voiceId: string, phrases: { key: string; text: string }[], signal?: AbortSignal) => AsyncIterable<PackEvent>;
  download: (hash: string) => Promise<Blob>;
}
const realDeps = (): PackDeps => ({ store: platform.audioStore, manifest: sharedManifest(), getConfig: getTtsConfig, stream: streamPack, download: fetchAudio });

/** Что отправляется в Fish: числа словами, лишние пробелы убраны. Ключ в манифесте считается по исходному тексту. */
export const spokenText = (text: string): string => spellNumbers(normalizeText(text));

/** Привести манифест в соответствие с серверными параметрами. Сменились — прежний пак устарел и чистится. */
export async function applyConfig(cfg: TtsConfig, voiceId: string, d: Pick<PackDeps, 'store' | 'manifest'> = realDeps()): Promise<void> {
  d.manifest.setParamsHash(paramsHashOf(cfg.params, cfg.format));
  for (const name of d.manifest.invalidateExcept(voiceId)) await d.store.remove(name);
}
export async function syncParams(voiceId: string, d: PackDeps = realDeps()): Promise<TtsConfig> {
  const cfg = await d.getConfig();
  await applyConfig(cfg, voiceId, d);
  return cfg;
}

export async function preparePhrases(
  voiceId: string, texts: string[], opts: { signal?: AbortSignal; onProgress?: (p: PackProgress) => void } = {}, d: PackDeps = realDeps()
): Promise<PackResult> {
  const result: PackResult = { ok: 0, failed: 0, skipped: 0, total: 0, aborted: false };
  if (!d.store.available) return { ...result, fatal: 'На этом устройстве некуда сохранять озвучку' };
  const unique = new Map<string, string>();
  for (const t of texts) { const n = normalizeText(t); if (n) unique.set(textKey(n), n); }
  result.total = unique.size;

  try { await syncParams(voiceId, d); } catch (e) { return { ...result, fatal: e instanceof Error ? e.message : 'Сервер недоступен' }; }

  const todo: [string, string][] = [];
  for (const [key, text] of unique) {
    const e = d.manifest.lookup(voiceId, text);
    if (e && (await d.store.has(e.name))) result.skipped++; else todo.push([key, text]);
  }
  const report = () => opts.onProgress?.({ done: result.ok + result.skipped, total: result.total, failed: result.failed });
  report();

  for (let i = 0; i < todo.length && !result.fatal && !result.aborted; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const originals = new Map(batch);
    try {
      for await (const ev of d.stream(voiceId, batch.map(([key, text]) => ({ key, text: spokenText(text) })), opts.signal)) {
        if (opts.signal?.aborted) { result.aborted = true; break; }
        if (ev.type === 'item') {
          const original = originals.get(ev.key);
          if (!original) continue;
          try {
            const blob = await d.download(ev.hash);
            const name = `${ev.hash}.${ev.ext}`;
            await d.store.put(name, blob);
            d.manifest.set(voiceId, original, { name, hash: ev.hash, ext: ev.ext, bytes: blob.size || ev.bytes, duration: ev.duration });
            result.ok++;
          } catch { result.failed++; }
        } else if (ev.type === 'error') result.failed++;
        else if (ev.type === 'fatal') { result.fatal = ev.message; break; }
        report();
      }
    } catch (e) {
      if (opts.signal?.aborted || (e instanceof DOMException && e.name === 'AbortError')) result.aborted = true;
      else result.fatal = e instanceof Error ? e.message : 'Не удалось собрать озвучку';
    }
  }
  return result;
}

let running: Promise<unknown> | null = null;
/** Одна сборка за раз: сервер всё равно не примет вторую. */
export async function exclusive<T>(fn: () => Promise<T>): Promise<T | 'busy'> {
  if (running) return 'busy';
  const p = fn();
  running = p;
  try { return await p; } finally { running = null; }
}

export const prepareStaticPack = (voiceId: string, opts?: { signal?: AbortSignal; onProgress?: (p: PackProgress) => void }, d?: PackDeps) =>
  exclusive(() => preparePhrases(voiceId, staticTexts(), opts, d));

export type RoutePackOutcome = 'skipped' | 'busy' | PackResult;
/** Маршрутный пак при построении маршрута. Если Fish выключен или не выбран голос — ничего не делает. Ошибки не бросает. */
export async function prepareRoutePack(plan: PlannedRoute, s: Pick<Settings, 'ttsEngine' | 'ttsVoiceId'>, opts?: { signal?: AbortSignal; onProgress?: (p: PackProgress) => void }, d?: PackDeps): Promise<RoutePackOutcome> {
  if (s.ttsEngine !== 'fish' || !s.ttsVoiceId) return 'skipped';
  try { return await exclusive(() => preparePhrases(s.ttsVoiceId, [...staticTexts(), ...routeTexts(plan)], opts, d)); }
  catch (e) { return { ok: 0, failed: 0, skipped: 0, total: 0, aborted: false, fatal: e instanceof Error ? e.message : 'Не удалось подготовить озвучку' }; }
}

/** Сколько места занимает озвучка на устройстве. */
export async function usage(store: AudioStoreApi = platform.audioStore): Promise<{ files: number; bytes: number }> {
  const l = await store.list();
  return { files: l.length, bytes: l.reduce((a, f) => a + f.bytes, 0) };
}

/** Удалить всю озвучку с устройства. */
export async function clearAll(d: Pick<PackDeps, 'store' | 'manifest'> = realDeps()): Promise<void> {
  d.manifest.clear();
  for (const f of await d.store.list()) await d.store.remove(f.name);
}

/** Голос удалён на сервере: убрать его файлы и записи на устройстве. */
export async function dropVoice(voiceId: string, d: Pick<PackDeps, 'store' | 'manifest'> = realDeps()): Promise<void> {
  for (const name of d.manifest.removeVoice(voiceId)) await d.store.remove(name);
}
