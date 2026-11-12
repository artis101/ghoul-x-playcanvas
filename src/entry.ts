async function start(): Promise<void> {
  const path = window.location.pathname.replace(/\/$/, '');
  const isCharacterLab = path === '/gm/characters';
  const isLevelLab = path === '/gm/levels';
  try {
    if (isLevelLab) {
      const { openLevelLab } = await import('./engine/gm/levelLab.ts');
      openLevelLab();
    } else if (isCharacterLab) {
      const { openCharacterLab } = await import('./engine/gm/characterLab.ts');
      await openCharacterLab();
    } else {
      const { bootstrap } = await import('./main.ts');
      await bootstrap();
    }
  } catch (error) {
    console.error('GHOUL-X bootstrap failed:', error);
    if (isCharacterLab || isLevelLab) {
      const root = document.getElementById('app-root');
      if (root) root.textContent = 'Preview could not start. Reload to try again.';
    }
  }
}

void start();
