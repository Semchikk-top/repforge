import { policyIntro, policySections } from '../legal/policy';
import { IconBack } from '../ui/Icons';
import { go } from '../state/router';

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
    </div>
  );
}
