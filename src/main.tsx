import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
// Только реально используемые веса и latin-подмножества: русский текст и так идёт системным
// fallback (в Barlow нет кириллицы), а полные CSS-файлы тянули в precache 30 файлов шрифтов.
import '@fontsource/barlow/latin-400.css';
import '@fontsource/barlow/latin-600.css';
import '@fontsource/barlow-condensed/latin-500.css';
import '@fontsource/barlow-condensed/latin-600.css';
import './styles.css';
import App from './App';
import { SettingsProvider } from './state/settings';
import { applyTheme, storedTheme } from './state/theme';
import { RestTimerProvider } from './state/timer';
import { CleanupGateProvider } from './state/cleanupGate';
import { ToastProvider } from './ui/Toast';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { RoomProvider } from './nearby/RoomProvider';
import { initPlatform, isNative } from './platform';
import { snapshotBeforeMigration } from './db/premigration';

async function boot() {
  // В браузере это мгновенный no-op; в Capacitor подгружается нативная реализация платформы.
  await initPlatform();

  // До первого обращения к базе: если схема IndexedDB будет обновлена, сначала сохраняем снимок данных.
  // Не получилось сохранить: миграцию без явного согласия пользователя не запускаем, данные остаются нетронутыми.
  const snap = await snapshotBeforeMigration();
  if (snap.status === 'failed' && !window.confirm(`Не удалось сохранить копию данных перед обновлением базы (${snap.error}).\n\nПродолжить без копии? Если отказаться, данные останутся как были, а приложение не запустится до повторной попытки.`)) {
    document.getElementById('root')!.textContent = 'Обновление базы отменено, данные не тронуты. Перезагрузи страницу, чтобы повторить.';
    return;
  }

  // Регистрируем после window.load: установка service worker сразу скачивает precache и на первом
  // запуске конкурирует с самим приложением за канал. Офлайн-режим включится на секунду позже.
  // В нативной оболочке service worker не нужен: ресурсы лежат в самом приложении, а SW кэшировал бы старый бандл.
  if (!isNative()) registerSW({ immediate: false });

  // Просим браузер не вычищать данные при нехватке места
  void navigator.storage?.persist?.();

  applyTheme(storedTheme()); // тема до первой отрисовки: без мигания
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <SettingsProvider>
        <RestTimerProvider>
          <CleanupGateProvider>
            <ToastProvider>
              <RoomProvider>
                <ErrorBoundary>
                  <App />
                </ErrorBoundary>
              </RoomProvider>
            </ToastProvider>
          </CleanupGateProvider>
        </RestTimerProvider>
      </SettingsProvider>
    </StrictMode>
  );
}

void boot();
