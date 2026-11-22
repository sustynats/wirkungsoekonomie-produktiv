import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readRepositoryStorage} from '../news/check-git-size.mjs';

// Read-only monitoring must work even when GitHub rejects all repository writes.
// The caller retains delivery state outside this repository and handles changes.
export function storageReport({measure = readRepositoryStorage, now = () => new Date()} = {}) {
  const measurement = measure();
  const exitCode = measurement.state === 'stop' ? 2 : 0;
  return {...measurement, measuredAt: now().toISOString(), readOnly: true,
    repositoryWrites: 0, independentOfGitState: true, exitCode};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = storageReport();
    console.log(JSON.stringify(report));
    process.exitCode = report.exitCode;
  } catch (error) {
    console.error(JSON.stringify({state: 'unknown', readOnly: true, repositoryWrites: 0,
      error: error.message, exitCode: 1}));
    process.exitCode = 1;
  }
}
