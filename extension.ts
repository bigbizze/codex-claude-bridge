import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createBridge, createCodec, catalog } from './bridge.mjs';

export default function (pi: any) {
  let bridge: ReturnType<typeof createBridge> | undefined;
  pi.on('session_start', async (_event: unknown, ctx: any) => {
    const token = process.env.CODEX_PI_BRIDGE_TOKEN;
    const keyFile = process.env.CODEX_PI_STATE_KEY_FILE;
    if (!token || !keyFile) throw new Error('Start this extension through codex-claude.');
    bridge = createBridge({ registry: ctx.modelRegistry, token, codec: createCodec(readFileSync(keyFile)) });
    await new Promise<void>((resolve, reject) => {
      bridge!.server.once('error', reject);
      bridge!.server.listen(0, '127.0.0.1', resolve);
    });
    const address = bridge.server.address();
    const readyFile = process.env.CODEX_PI_READY_FILE!;
    writeFileSync(readyFile + '.tmp', JSON.stringify({ port: typeof address === 'object' && address?.port,
      catalog: catalog(ctx.modelRegistry.getAvailable().filter((model: any) => model.provider === 'anthropic')) }), { mode: 0o600 });
    renameSync(readyFile + '.tmp', readyFile);
  });
  pi.on('session_shutdown', async () => bridge?.close());
}
