// Immutable transport for the existing lossless newsroom parts. No credentials
// are sent to download URLs. The raw and compressed bytes are both pinned.
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {gzipSync, gunzipSync} from 'node:zlib';

export const LEGACY_DATA_REPOSITORY = 'sustynats/wirkungsoekonomie.de';
export const DATA_REPOSITORY = 'sustynats/wirkungsoekonomie-produktiv';
export const RELEASE_PART_FORMAT = 'woek-release-part-gzip-1';
export const RELEASE_STORE_FORMAT = 'github-release-parts-1';
export const partDigest = bytes => createHash('sha256').update(bytes).digest('hex');
const MAX_PART = 8 * 1024 * 1024;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const validDataTag = tag => typeof tag === 'string'
  && /^wirkungsticker-data-\d{4}-(?:0[1-9]|1[0-2])(?:-part-(?:[2-9]|[1-9]\d+))?$/.test(tag);

const NATIVE_CODES = new Set(['NONE', 'OTHER', 'ENOENT', 'ENOBUFS',
  'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', 'EACCES', 'EPERM', 'ETIMEDOUT', 'EIO']);
const SIGNALS = new Set(['NONE', 'OTHER', 'SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT',
  'SIGHUP', 'SIGQUIT', 'SIGPIPE', 'SIGSEGV', 'SIGBUS', 'SIGALRM']);
const STDERR_SHAPES = new Set(['NONE', 'SINGLE_LINE', 'MULTILINE', 'OVERSIZED', 'INVALID']);
const FIELD_STATES = new Set(['VALID', 'INVALID', 'CONFLICT']);
const exitStatus = value => Number.isSafeInteger(value) && value >= 0 && value <= 255;
const emptyPrivateFields = () => ({exit_status: null, native_code: 'NONE', stderr_shape: 'NONE',
  killed: false, signal: 'NONE', fields_state: 'INVALID'});

// Revalidate even already sanitized fields at the CLI boundary. No free-form
// client value can be copied into output through a spoofed Error object.
export function privateDownloadDiagnosticFields(error) {
  try {
    if (!error) return emptyPrivateFields();
    const {exit_status, native_code, stderr_shape, killed, signal, fields_state} = error;
    if ((exit_status !== null && !exitStatus(exit_status)) ||
        !NATIVE_CODES.has(native_code) || !STDERR_SHAPES.has(stderr_shape) ||
        typeof killed !== 'boolean' || !SIGNALS.has(signal) || !FIELD_STATES.has(fields_state)) {
      return emptyPrivateFields();
    }
    return {exit_status, native_code, stderr_shape, killed, signal, fields_state};
  } catch { return emptyPrivateFields(); }
}

// Only bounded, typed child-process fields are inspected. Never retain client
// output, signed URLs or the original error as a cause on the public error.
export function privateDownloadFailureDiagnostic(error) {
  const result = {...emptyPrivateFields(), category: 'UNKNOWN'};
  try {
    if (!error || typeof error !== 'object') return result;
    const {code, status, signal, killed, stderr} = error;
    result.native_code = typeof code === 'string' ? NATIVE_CODES.has(code) ? code : 'OTHER' : 'NONE';
    result.signal = signal ? SIGNALS.has(signal) ? signal : 'OTHER' : 'NONE';
    result.killed = killed === true;
    let text;
    if (stderr == null) result.stderr_shape = 'NONE';
    else if (typeof stderr !== 'string' && !Buffer.isBuffer(stderr)) result.stderr_shape = 'INVALID';
    else if (stderr.length > 8192 || Buffer.byteLength(stderr) > 8192) result.stderr_shape = 'OVERSIZED';
    else {
      text = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : stderr;
      if (Buffer.isBuffer(stderr) && !Buffer.from(text).equals(stderr)) result.stderr_shape = 'INVALID';
      else result.stderr_shape = !text.trim() ? 'NONE' : /[\r\n]/.test(text.trim()) ? 'MULTILINE' : 'SINGLE_LINE';
    }
    if ((code != null && typeof code !== 'string' && !exitStatus(code)) ||
        (status != null && !exitStatus(status)) ||
        (signal != null && typeof signal !== 'string') ||
        (killed !== undefined && typeof killed !== 'boolean') ||
        result.stderr_shape === 'INVALID') return result;
    if ((typeof code === 'string' && code.length > 64) ||
        (typeof signal === 'string' && signal.length > 32)) return result;
    result.fields_state = 'VALID';
    // execFile reports a numeric exit in code; execFileSync uses status.
    // Native launch/buffer codes cannot also describe a numeric child exit.
    if (code != null && status != null && code !== status ||
        (exitStatus(code) || exitStatus(status) || code === 'ENOENT') && (signal || killed)) {
      result.fields_state = 'CONFLICT';
      return result;
    }
    result.exit_status = exitStatus(code) ? code : exitStatus(status) ? status : null;
    if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || code === 'ENOBUFS') return {...result, category: 'OUTPUT_LIMIT'};
    if (code === 'ENOENT') return {...result, category: 'CLIENT_MISSING'};
    if (signal || killed) return {...result, category: 'TERMINATED_UNKNOWN'};
    if (!(result.exit_status > 0) || !text || result.stderr_shape === 'OVERSIZED') return result;
    // Fixed release-download messages in gh v2.97.0. These are not HTTP or
    // transient classifications and do not authorize another attempt.
    const known = new Map([['release not found', 'RELEASE_NOT_FOUND'],
      ['no assets match the file pattern', 'ASSET_PATTERN_NO_MATCH'], ['no assets to download', 'NO_ASSETS']]);
    if (known.has(text.trim())) return {...result, category: known.get(text.trim())};
    // Context lines are allowed only around a single standard gh HTTP line.
    // A second HTTP occurrence, even the same code, remains ambiguous.
    const matches = [...text.matchAll(/\bHTTP ([1-5]\d\d)\b/g)];
    if (matches.length !== 1) return result;
    const lines = text.trim().split(/\r?\n/);
    const standard = lines.map(line => /^(?:gh: [^\r\n]* \(HTTP ([45]\d\d)\)|HTTP ([45]\d\d): [^\r\n]+)$/.exec(line)).find(Boolean);
    return standard ? {...result, category: `HTTP_${standard[1] || standard[2]}`} : result;
  } catch { return {...emptyPrivateFields(), category: 'UNKNOWN'}; }
}

export function privateDownloadFailureCategory(error) {
  return privateDownloadFailureDiagnostic(error).category;
}

export function privateReleaseDownloadError(error) {
  const safe = Error('RELEASE_PART_PRIVATE_DOWNLOAD_UNAVAILABLE');
  Object.assign(safe, privateDownloadFailureDiagnostic(error));
  safe.phase = 'private_release_download';
  return safe;
}

export function assertRawPart(bytes, part) {
  if (!hash(part?.sha256) || !Number.isSafeInteger(part.bytes) || part.bytes < 1 || part.bytes > MAX_PART)
    throw Error('RELEASE_PART_INVALID');
  if (!Buffer.isBuffer(bytes) || bytes.length !== part.bytes || partDigest(bytes) !== part.sha256)
    throw Error('RELEASE_PART_RAW_CORRUPT');
  return bytes;
}

export function releasePartUrl(part) {
  const release = part?.release;
  const repository = release?.repository ?? LEGACY_DATA_REPOSITORY;
  if (!hash(part?.sha256) || !Number.isSafeInteger(part.bytes) || part.bytes < 1 || part.bytes > MAX_PART
      || release?.storage_format !== RELEASE_PART_FORMAT || !validDataTag(release.tag)
      || ![LEGACY_DATA_REPOSITORY, DATA_REPOSITORY].includes(repository)
      || release.asset !== `${part.sha256}.json.gz` || !hash(release.sha256)
      || !Number.isSafeInteger(release.bytes) || release.bytes < 1 || release.bytes > part.bytes + 65536)
    throw Error('RELEASE_PART_REFERENCE_INVALID');
  return `https://github.com/${repository}/releases/download/${release.tag}/${release.asset}`;
}

export function encodeReleasePart(bytes, part) {
  assertRawPart(bytes, part);
  return gzipSync(bytes, {level: 6});
}

export function decodeReleasePart(bytes, part) {
  releasePartUrl(part);
  if (!Buffer.isBuffer(bytes) || bytes.length !== part.release.bytes || partDigest(bytes) !== part.release.sha256)
    throw Error('RELEASE_PART_COMPRESSED_CORRUPT');
  let raw;
  try { raw = gunzipSync(bytes, {maxOutputLength: part.bytes}); }
  catch { throw Error('RELEASE_PART_GZIP_INVALID'); }
  return assertRawPart(raw, part);
}

export function releasePartDownloadCommand(url, maxBytes) {
  // Private release assets cannot be read by the anonymous GitHub URL. Keep
  // authentication inside gh and pin the exact repository, tag, and filename;
  // credentials never appear in a URL or subprocess arguments.
  const parsed = new URL(url);
  const prefix = `/${DATA_REPOSITORY}/releases/download/`;
  if (parsed.origin === 'https://github.com' && parsed.pathname.startsWith(prefix)) {
    const remainder = parsed.pathname.slice(prefix.length).split('/');
    if (parsed.username || parsed.password || parsed.search || parsed.hash
        || remainder.length !== 2 || !validDataTag(remainder[0])
        || !/^[a-f0-9]{64}\.json\.gz$/.test(remainder[1])
        || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_PART + 65536)
      throw Error('RELEASE_PART_REFERENCE_INVALID');
    return {private: true, command: 'gh', args: ['release', 'download', remainder[0],
      '--repo', DATA_REPOSITORY, '--pattern', remainder[1], '--output', '-'],
      options: {timeout: 50000, maxBuffer: maxBytes + 1024}};
  }
  return {private: false, command: 'curl', args: ['--fail', '--silent', '--show-error', '--location',
    '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '10',
    '--max-time', '45', '--max-filesize', String(maxBytes), '--url', url],
    options: {timeout: 50000, maxBuffer: maxBytes + 1024}};
}

export function downloadReleasePart(url, maxBytes, {run = execFileSync} = {}) {
  const spec = releasePartDownloadCommand(url, maxBytes);
  try {
    return run(spec.command, spec.args, {...spec.options, stdio: ['ignore', 'pipe', 'pipe']});
  } catch (error) {
    // Do not expose client stderr, signed redirects, or credentials in logs.
    if (spec.private) throw privateReleaseDownloadError(error);
    throw error;
  }
}

// Only a declared, pinned release reference can cause a read. A missing legacy
// part remains an error; a corrupt local part is never silently replaced.
export function readReleasedPart(part, {download = downloadReleasePart} = {}) {
  const url = releasePartUrl(part);
  return decodeReleasePart(download(url, part.release.bytes), part);
}
