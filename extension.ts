import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createBridge, createCodec, catalog } from './bridge.mjs';
import { mergeCatalogs } from './model-catalog.mjs';
import { createUsage } from './usage.mjs';
import { waitPolicy } from './limits.mjs';
import { createBackend } from './backend.mjs';
import { createWarnings } from './warnings.mjs';

const listen = (server: any) => new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

export default function (pi: any) {
  let bridge: ReturnType<typeof createBridge> | undefined;
  let backend: ReturnType<typeof createBackend> | undefined;
  pi.on('session_start', async (_event: unknown, ctx: any) => {
    const token = process.env.CODEX_PI_BRIDGE_TOKEN;
    const keyFile = process.env.CODEX_PI_STATE_KEY_FILE;
    if (!token || !keyFile) throw new Error('Start this extension through codex-claude.');
    const openaiCatalogFile = process.env.CODEX_PI_OPENAI_CATALOG;
    const openaiCatalog = openaiCatalogFile ? JSON.parse(readFileSync(openaiCatalogFile, 'utf8')) : { models: [] };
    const log = process.env.CODEX_PI_DEBUG ? (line: string) => console.error(`[pi-codex] ${line}`) : () => {};
    const warn = createWarnings(process.env.CODEX_PI_WARNINGS_FILE, log);
    const usageReader = createUsage({ claudeToken: () => ctx.modelRegistry.getApiKeyForProvider('anthropic'), log, warn });
    bridge = createBridge({ registry: ctx.modelRegistry, token, codec: createCodec(readFileSync(keyFile)), usageReader, limitPolicy: waitPolicy(),
      openai: openaiCatalogFile ? { catalog: openaiCatalog } : undefined });
    await listen(bridge.server);
    let backendPort;
    if (process.env.CODEX_PI_TLS_KEY && process.env.CODEX_PI_TLS_CERT) {
      backend = createBackend({ key: readFileSync(process.env.CODEX_PI_TLS_KEY), cert: readFileSync(process.env.CODEX_PI_TLS_CERT), secret: token, usageReader, log, warn });
      await listen(backend);
      const address = backend.address();
      backendPort = typeof address === 'object' && address?.port;
    }
    const address = bridge.server.address();
    const readyFile = process.env.CODEX_PI_READY_FILE!;
    writeFileSync(readyFile + '.tmp', JSON.stringify({ port: typeof address === 'object' && address?.port, backendPort,
      catalog: mergeCatalogs(catalog(ctx.modelRegistry.getAvailable().filter((model: any) => model.provider === 'anthropic')), openaiCatalog) }), { mode: 0o600 });
    renameSync(readyFile + '.tmp', readyFile);
  });
  pi.on('session_shutdown', async () => {
    bridge?.close();
    backend?.closeAllConnections();
    backend?.close();
  });
}
