// Правки AndroidManifest.xml, которые нельзя оставить на ручную память. Чистые функции: их проверяют тесты.

/** Без <queries> с TTS_SERVICE Android 11+ скрывает системный движок озвучки, и голосовые подсказки молчат. Повторный вызов ничего не меняет. */
export function ensureTtsQueries(xml) {
  if (xml.includes('android.intent.action.TTS_SERVICE')) return xml;
  const block = '    <queries>\n        <intent>\n            <action android:name="android.intent.action.TTS_SERVICE" />\n        </intent>\n    </queries>\n';
  if (/<queries>/.test(xml)) return xml.replace(/<queries>/, '<queries>\n        <intent>\n            <action android:name="android.intent.action.TTS_SERVICE" />\n        </intent>');
  if (!xml.includes('</manifest>')) throw new Error('Нет </manifest>: манифест повреждён');
  return xml.replace('</manifest>', block + '</manifest>');
}
