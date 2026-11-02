// Подставляется вместо virtual:pwa-register в нативной сборке (vite build --mode native): service worker там не нужен.
export function registerSW(_options?: unknown): (reload?: boolean) => Promise<void> {
  return async () => {};
}
