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
import { ToastProvider } from './ui/Toast';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { RoomProvider } from './nearby/RoomProvider';

// Регистрируем после window.load: установка service worker сразу скачивает precache и на первом
// запуске конкурирует с самим приложением за канал. Офлайн-режим включится на секунду позже.
registerSW({ immediate: false });

// Просим браузер не вычищать данные при нехватке места
void navigator.storage?.persist?.();

applyTheme(storedTheme()); // тема до первой отрисовки: без мигания
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SettingsProvider>
      <RestTimerProvider>
        <ToastProvider>
          <RoomProvider>
            <ErrorBoundary>
              <App />
            </ErrorBoundary>
          </RoomProvider>
        </ToastProvider>
      </RestTimerProvider>
    </SettingsProvider>
  </StrictMode>
);
