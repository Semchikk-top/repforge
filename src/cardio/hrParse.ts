// Разбор характеристики «Heart Rate Measurement» (GATT 0x2A37). Формат стандартный: Polar, Garmin, Wahoo и др.
// Байт флагов: бит 0 — пульс в 16 битах; биты 1–2 — контакт с кожей (бит 2: поддерживается, бит 1: есть контакт);
// бит 3 — есть «энергозатраты» (2 байта); бит 4 — далее идут RR-интервалы (по 2 байта, в 1/1024 с).

import type { HrSample } from '../platform/types';
export type { HrSample };

export const HR_SERVICE_UUID = '0000180d-0000-1000-8000-00805f9b34fb';
export const HR_MEASUREMENT_UUID = '00002a37-0000-1000-8000-00805f9b34fb';

/** null, если данных слишком мало (обрезанный пакет): такие значения просто пропускаем. */
export function parseHeartRate(view: DataView): HrSample | null {
  if (view.byteLength < 2) return null;
  const flags = view.getUint8(0);
  const wide = (flags & 0x01) !== 0;
  let i = 1;
  if (view.byteLength < i + (wide ? 2 : 1)) return null;
  const bpm = wide ? view.getUint16(i, true) : view.getUint8(i);
  i += wide ? 2 : 1;
  const contactSupported = (flags & 0x04) !== 0;
  const contact = contactSupported ? (flags & 0x02) !== 0 : null;
  if (flags & 0x08) i += 2; // энергозатраты нам не нужны
  const rr: number[] = [];
  if (flags & 0x10) {
    for (; i + 1 < view.byteLength; i += 2) rr.push(Math.round((view.getUint16(i, true) * 1000) / 1024));
  }
  return { bpm, contact, rr };
}
