// Данные оператора и ссылки. ЗАПОЛНИТЬ ПЕРЕД ПУБЛИКАЦИЕЙ: значения в угловых скобках — заглушки.
export const LEGAL = {
  updated: '02.11.2026',
  operator: 'Коломацкий Семён Дмитриевич, применяющий НПД, ИНН 421815687221',
  email: 'simonkolom@mail.ru',
  privacyUrl: 'https://semchikk-top.github.io/repforge/privacy/',
  githubUrl: 'https://github.com/Semchikk-top/repforge#readme',
  supportUrl: 'https://boosty.to/mindmirror/donate',
  minAge: '12+'
};

export const legalFilled = () => !Object.values(LEGAL).some((v) => v.includes('<'));
