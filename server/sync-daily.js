import 'dotenv/config';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const jobs = [
  { name: 'Raider.IO current-run sample', file: 'sync.js' },
  { name: 'weekly periods and regional leaderboards', file: 'sync-weekly.js' }
];
let failed = false;

for (const [index, job] of jobs.entries()) {
  console.log(`[daily-sync] Starting step ${index + 1}/${jobs.length}: ${job.name}.`);
  const success = await new Promise((resolve) => {
    // Explicitly relay child output so scheduled-task terminals can stream it.
    const child = spawn(process.execPath, [path.join(here, job.file)], {
      stdio: ['inherit', 'pipe', 'pipe'],
      env: process.env,
      windowsHide: true
    });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    child.stdout?.on('data', (chunk) => process.stdout.write(chunk));
    child.stderr?.on('data', (chunk) => process.stderr.write(chunk));
    child.once('error', (error) => {
      console.error(`[daily-sync] Could not start ${job.name}: ${error.message}`);
      finish(false);
    });
    child.once('exit', (code, signal) => {
      if (signal) console.error(`[daily-sync] ${job.name} stopped by signal ${signal}.`);
      finish(code === 0);
    });
  });
  if (!success) {
    console.error(`[daily-sync] ${job.name} failed; continuing with the next step.`);
    failed = true;
  } else {
    console.log(`[daily-sync] Completed step ${index + 1}/${jobs.length}: ${job.name}.`);
  }
}

if (failed) {
  console.error('[daily-sync] Finished with one or more failed steps.');
  process.exitCode = 1;
} else {
  console.log('[daily-sync] All imports completed successfully.');
}
