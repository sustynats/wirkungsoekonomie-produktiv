import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {assertStagedStorage,repositoryStorageState} from './check-git-size.mjs';
const policy = JSON.parse(fs.readFileSync(new URL('../../docs/ops/GIT-STORAGE-POLICY.json',import.meta.url),'utf8'));

// Contents/Ref API clients do not have a Git index. Admit the exact raw state
// payload before creating a ref or submitting a Contents write instead.
export async function guardGitHubContentUpdate({file,content,readRepository} = {}) {
  if (typeof file !== 'string' || !file || file.includes('\0') || file.includes('\\') ||
      file.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
    throw Error('GIT_STORAGE_API_PATH_INVALID');
  }
  if (!(typeof content === 'string' || Buffer.isBuffer(content))) throw Error('GIT_STORAGE_API_CONTENT_INVALID');
  const raw = Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(content,'utf8');
  if (raw.length > policy.maximum_api_state_bytes) throw Error('GIT_STORAGE_API_STATE_TOO_LARGE');
  const text = new TextDecoder('utf-8',{fatal:true}).decode(raw);
  if (file.endsWith('.json')) JSON.parse(text);
  assertStagedStorage([{file,bytes:raw.length,oid:'0'.repeat(40)}],() => text);
  if (typeof readRepository !== 'function') throw Error('GIT_STORAGE_REPOSITORY_READ_REQUIRED');
  const repository = await readRepository();
  if (repository?.full_name !== policy.repository || !Number.isSafeInteger(repository?.size) || repository.size < 0) {
    throw Error('GIT_STORAGE_REPOSITORY_SIZE_INVALID');
  }
  const state = repositoryStorageState(repository.size * 1024);
  if (policy.enforce_total_repository_after_cleanup && state === 'stop') throw Error('GIT_STORAGE_REPOSITORY_STOP');
  return {file,bytes:raw.length,sha256:createHash('sha256').update(raw).digest('hex'),
    repository:state,totalStopActivated:policy.enforce_total_repository_after_cleanup};
}
