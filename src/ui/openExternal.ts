import { platform } from '../platform';

// Внешняя ссылка: в нативной оболочке — системный браузер (Custom Tabs), в вебе — новая вкладка.
export async function openExternal(url: string): Promise<boolean> {
  try {
    if (platform.info.native) {
      const { Browser } = await import('@capacitor/browser');
      await Browser.open({ url });
    } else {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
    return true;
  } catch {
    return false;
  }
}
