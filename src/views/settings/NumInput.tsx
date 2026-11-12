import { useState } from 'react';

// Числовое поле настроек, которое можно полностью очистить. Обычный контролируемый
// input с валидацией в onChange отвергает промежуточные состояния: пока текст не
// разбирается в число (например, пустая строка после Backspace), значение настроек
// не меняется, и контролируемый input мгновенно возвращает старое число — набрать
// «0» невозможно. Поэтому пока фокус в поле, показываем черновик ввода как есть и
// обновляем настройку только когда текст разбирается; пустое поле считаем нулём
// (для целей недели 0 = «выключено»). На выходе из поля неразобранный черновик
// откатывается к значению из настроек.
export function NumInput({ id, inputMode, value, parse, onChange }: {
  id: string;
  inputMode: 'numeric' | 'decimal';
  value: number;
  parse: (text: string) => number | null;
  onChange: (n: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? String(value);
  return (
    <input id={id} className="input" inputMode={inputMode} value={text}
      onChange={(e) => {
        const t = e.target.value;
        setDraft(t);
        const n = parse(t);
        if (n !== null) onChange(n);
      }}
      onBlur={() => setDraft(null)}
    />
  );
}
