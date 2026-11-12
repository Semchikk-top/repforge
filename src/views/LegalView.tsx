import { policyIntro, policySections } from '../legal/policy';
import { IconBack } from '../ui/Icons';
import { go } from '../state/router';
import { catalog } from '../content/catalog';
import { EDU_NOTICE } from '../content/types';
import { openExternal } from '../ui/openExternal';

// Политика конфиденциальности внутри приложения: открывается без сети.
export function LegalView() {
  return (
    <div>
      <div className="head-row">
        <button className="icon-btn" onClick={() => go('settings')} aria-label="К настройкам"><IconBack /></button>
        <h1 style={{ margin: 0 }}>Политика конфиденциальности</h1>
      </div>
      {policyIntro.map((t) => <p key={t} className="sub">{t}</p>)}
      {policySections.map((s) => (
        <div className="section" key={s.title} style={{ marginTop: 16 }}>
          <h2>{s.title}</h2>
          {s.paragraphs.map((p) => <p key={p} style={{ marginTop: 8 }}>{p}</p>)}
        </div>
      ))}
      <div className="section" style={{ marginTop: 16 }} data-testid="legal-edu">
        <h2>Образовательные материалы</h2>
        <p style={{ marginTop: 8 }}>{EDU_NOTICE} Карточки «Зачем это», объяснения «Почему так» и ответы ассистента по справочнику объясняют принципы и не заменяют тренера или врача. Карта нагрузки показывает оценку по подходам, а не измерение, и не даёт медицинских выводов. Отметка о прохождении курса хранится только на твоих устройствах и на твоём сервере, в рейтинг и друзьям не уходит и не является документом. Если во время тренировки появилась боль или самочувствие ухудшилось, остановись и обратись к специалисту.</p>
        <p style={{ marginTop: 8 }}>Тексты проверяет человек перед публикацией; в приложение попадает только проверенное. Содержимое входит в сборку и работает без сети.</p>
        {catalog.allSources().length > 0 ? (
          <ul className="why-list why-sources">
            {catalog.allSources().map((s) => (
              <li key={s.id}><button className="link-btn" onClick={() => void openExternal(s.url)}>{s.title}</button>, {s.author}. Лицензия: {s.license}. Получено: {s.retrievedAt}.</li>
            ))}
          </ul>
        ) : (
          <p className="sub" style={{ marginTop: 8 }}>Источники появятся вместе с первыми опубликованными карточками.</p>
        )}
      </div>
    </div>
  );
}
