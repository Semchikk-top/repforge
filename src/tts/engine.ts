// Гибридный движок озвучки: готовый файл Fish из памяти устройства, иначе системный голос.
// Подходит под SpeechEngine очереди SpeechQueue ({speak, stop}), приоритеты и ttlMs очереди не меняются.
//
// Горячий путь тренировки: только локальные операции (манифест в памяти, файл на устройстве). Сети нет вообще.
// Нет пака, нет файла, звук не пошёл — сразу системный голос, без ожидания.

import type { Settings } from '../domain/types';
import type { AudioPlayerApi, AudioStoreApi, SpeechApi } from '../platform/types';
import type { SpeechEngine } from '../cardio/speechQueue';
import type { Manifest } from './cache';

export interface EngineDeps {
  system: Pick<SpeechApi, 'speak' | 'stop'>;
  store: AudioStoreApi;
  player: AudioPlayerApi;
  manifest: Manifest;
  settings: () => Pick<Settings, 'ttsEngine' | 'ttsVoiceId'>;
}

export function createSpeechEngine(d: EngineDeps): SpeechEngine {
  let epoch = 0; // stop() делает уже начатую подготовку недействительной: после него фраза не зазвучит
  return {
    async speak(text) {
      const my = epoch;
      const s = d.settings();
      if (s.ttsEngine === 'fish' && s.ttsVoiceId && d.store.available) {
        const entry = d.manifest.lookup(s.ttsVoiceId, text);
        if (entry) {
          let handle = null;
          try { handle = await d.store.open(entry.name); } catch { handle = null; }
          if (handle) {
            try {
              if (my !== epoch) return;
              if ((await d.player.play(handle.url)) === 'ended') return;
            } catch { /* падаем на системный голос */ } finally { handle.release(); }
          }
        }
      }
      if (my !== epoch) return;
      await d.system.speak(text);
    },
    async stop() {
      epoch++;
      await Promise.allSettled([d.player.stop(), d.system.stop()]);
    }
  };
}
