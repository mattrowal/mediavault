import { execSync } from 'node:child_process';

const port = process.env.PORT || 3001;

try {
  if (process.platform === 'win32') {
    execSync(`powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"`, { stdio: 'ignore' });
  } else {
    execSync(`fuser -k ${port}/tcp || true`, { stdio: 'ignore' });
  }
  console.log(`🛑 MediaVault server stopped on port ${port}.`);
} catch (err) {
  console.log(`🛑 MediaVault server stopped.`);
}
