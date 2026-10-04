import { HELP, parseOptions, SimulatorError } from './options';
import { runSimulator } from './simulator';

async function main(): Promise<void> {
  const parsed = parseOptions(process.argv.slice(2));
  if (parsed.help) {
    console.log(HELP);
    return;
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await runSimulator(parsed.options, {
      signal: controller.signal,
      log: (message) => console.log(message),
    });
    console.log('SIMULATOR completed');
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    console.log('SIMULATOR stopped');
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
void main().catch((error: unknown) => {
  console.error(error instanceof SimulatorError ? error.message : 'Simulator failed');
  process.exitCode = 1;
});
