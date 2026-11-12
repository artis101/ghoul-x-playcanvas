async function start(): Promise<void> {
  const isCharacterLab = window.location.pathname.replace(/\/$/, '') === '/gm/characters';
  try {
    if (isCharacterLab) {
      const { openCharacterLab } = await import('./engine/gm/characterLab.ts');
      await openCharacterLab();
    } else {
      const { bootstrap } = await import('./main.ts');
      await bootstrap();
    }
  } catch (error) {
    console.error('GHOUL-X bootstrap failed:', error);
    if (isCharacterLab) {
      const root = document.getElementById('app-root');
      if (root) root.textContent = 'Character Lab could not start. Reload to try again.';
    }
  }
}

void start();
