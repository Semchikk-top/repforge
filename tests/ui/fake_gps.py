"""Подменный GPS для браузерных тестов: отдаёт точки с заданными метками времени."""
FAKE_GPS = """
(() => {
  const watchers = new Map(); let id = 0;
  const fake = {
    watchPosition(ok, err) { id++; watchers.set(id, { ok, err }); return id; },
    clearWatch(i) { watchers.delete(i); },
    getCurrentPosition() {}
  };
  Object.defineProperty(navigator, 'geolocation', { value: fake, configurable: true });
  const M = 111195;
  window.__gps = {
    active: () => watchers.size,
    // идём на север со скоростью v м/с, по точке в секунду; возвращает метры от старта
    run(t0, m0, v, seconds, acc = 5, ele = null) {
      for (let i = 0; i <= seconds; i++) {
        const m = m0 + v * i;
        for (const w of watchers.values()) w.ok({ timestamp: t0 + i * 1000, coords: { latitude: 55.75 + m / M, longitude: 37.6, accuracy: acc, altitude: ele === null ? null : ele + i * 0.1, altitudeAccuracy: 5, heading: null, speed: null } });
      }
      return m0 + v * seconds;
    },
    fail(code) { for (const w of watchers.values()) w.err({ code, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3, message: 'x' }); }
  };
})();
"""
