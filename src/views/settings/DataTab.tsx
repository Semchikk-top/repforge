import { useEffect, useRef, useState } from 'react';
import { BackupSection } from '../BackupSection';
import { openBackupText } from '../../db/autoBackup';
import { exportAll } from '../../db/repo';
import { RestorePreview } from '../RestorePreview';
import { useToast } from '../../ui/Toast';
import { toDateStr } from '../../lib';
import { ExportSheet } from '../ExportSheet';
import { ImportWorkoutsSheet } from '../ImportWorkoutsSheet';
import { go } from '../../state/router';

export function DataTab() {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [exporting, setExporting] = useState(false);
  const [restore, setRestore] = useState<{ title: string; json: string } | null>(null);
  const [importingCsv, setImportingCsv] = useState(false);
  // Хранилище страницы: если система не обещает беречь данные при нехватке места, честно об этом говорим
  const [persisted, setPersisted] = useState<boolean | null>(null);
  useEffect(() => { void navigator.storage?.persisted?.().then(setPersisted).catch(() => setPersisted(null)); }, []);

  const doExport = async () => {
    const blob = new Blob([await exportAll()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `trenirovki-${toDateStr(new Date())}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  const doImport = async (file: File) => {
    try {
      // зашифрованную копию читаем по паролю (или ключом приложения, если она сделана здесь же)
      const text = await openBackupText(await file.text(), () => prompt('Пароль от этой копии'));
      setRestore({ title: `Импорт из файла «${file.name}»`, json: text }); // записываем только после подтверждения в предпросмотре
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Не удалось прочитать файл');
    }
  };

  return (
    <div className="section" style={{ marginTop: 0 }}>
      <h2>Данные</h2>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn" style={{ flex: 1 }} onClick={doExport}>Экспорт в файл</button>
        <button className="btn" style={{ flex: 1 }} onClick={() => fileRef.current?.click()}>Импорт из файла</button>
      </div>
      <button className="btn block" style={{ marginTop: 8 }} onClick={() => setExporting(true)}>Экспорт за период…</button>
      <button className="btn block" style={{ marginTop: 8 }} onClick={() => setImportingCsv(true)}>Импорт из Hevy или Strong…</button>
      <button className="btn block" style={{ marginTop: 8 }} onClick={() => go('start')}>Подобрать стартовую программу</button>
      {exporting && <ExportSheet onClose={() => setExporting(false)} />}
      {restore && <RestorePreview title={restore.title} json={restore.json} onClose={() => setRestore(null)} />}
      {importingCsv && <ImportWorkoutsSheet onClose={() => setImportingCsv(false)} />}
      <BackupSection />
      {persisted === false && <p className="sub" style={{ marginTop: 8 }}>Система не гарантирует сохранность данных приложения при нехватке места на телефоне. Делай экспорт или подключи синхронизацию с ПК.</p>}
      <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void doImport(f); e.target.value = ''; }} />
    </div>
  );
}
