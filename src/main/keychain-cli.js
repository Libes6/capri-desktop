'use strict';

// The master key of the Tauri build's key store, put there from the OUTSIDE of Rust: by the last
// Electron build, through the system's own command line tools (TAURI-09), so that the Tauri build
// finds it where src-tauri/src/secrets.rs looks (service `capri.desktop`, account `master-key`;
// CAPRI_KEYCHAIN_SERVICE for another service name: tests, try-outs). Nothing is run through a shell:
// every command is a file and an array of arguments.
//
//   macOS    `security` (the Keychain). Written through `security -i` (commands on stdin), so the key
//            is never an argument visible to other processes. Same item as keyring's apple-native:
//            a generic password, service + account. The item is trusted to `security` only: the
//            Tauri build reading it for the first time makes macOS ask once ("Capri wants to use ...
//            Always Allow"). CAPRI_KEYCHAIN_OPEN_ACL=1 (TESTS ONLY, with a test service) adds -A so
//            that an unattended run is not held up by that question.
//   Linux    `secret-tool` (libsecret), with the attributes keyring's sync-secret-service uses:
//            service, username, target=default, application=rust-keyring. The secret goes on stdin.
//   Windows  `cmdkey`: target `master-key.capri.desktop` (keyring: "<user>.<service>"), user
//            `master-key`. cmdkey cannot print a secret, so an item that is already there is
//            reported as "exists" (never overwritten: the Tauri build may have sealed keys with it).
//
// Checked: macOS (live, with a test service). NOT checked: Linux and Windows (written from the tools'
// documentation and keyring 3.6.3's source; see docs/TAURI_MIGRATION_DATA.md).

const { execFile } = require('node:child_process');

const SERVICE = 'capri.desktop';
const ACCOUNT = 'master-key';
const TIMEOUT_MS = 30000;

const serviceName = (env = process.env) => (env.CAPRI_KEYCHAIN_SERVICE || '').trim() || SERVICE;

// run(file, args, { input }) -> Promise<{ code, stdout, stderr }>; never rejects on a non-zero exit
function run(file, args, { input, timeout = TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const child = execFile(file, args, { timeout, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : err.killed ? 'timeout' : err.code || 1) : 0;
      resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
    child.on('error', () => {});
    if (input !== undefined) child.stdin?.end(input);
  });
}

// A store for a platform: { get() -> key | null, set(key), remove(), exists() } over `exec` (a stand-in in tests).
function createCliKeyStore({ platform = process.platform, env = process.env, exec = run } = {}) {
  const service = serviceName(env);

  if (platform === 'darwin') {
    return {
      service,
      async get() {
        const r = await exec('security', ['find-generic-password', '-s', service, '-a', ACCOUNT, '-w']);
        if (r.code === 0) return r.stdout.trim() || null;
        if (r.code === 44) return null; // errSecItemNotFound
        throw new Error(`security find-generic-password: ${r.code}`);
      },
      async exists() {
        const r = await exec('security', ['find-generic-password', '-s', service, '-a', ACCOUNT]);
        if (r.code === 0) return true;
        if (r.code === 44) return false;
        throw new Error(`security find-generic-password: ${r.code}`);
      },
      async set(key) {
        // base64 has no spaces or quotes: one word for the interactive parser
        if (!/^[A-Za-z0-9+/=]+$/.test(key)) throw new Error('keychain: the key is not base64');
        const open = env.CAPRI_KEYCHAIN_OPEN_ACL === '1' ? ['-A'] : [];
        const line = ['add-generic-password', ...open, '-s', service, '-a', ACCOUNT, '-w', key].join(' ');
        const r = await exec('security', ['-i'], { input: `${line}\n` });
        if (r.code !== 0 || /\bsecurity: |error/i.test(r.stderr + r.stdout)) throw new Error(`security add-generic-password: ${r.code}`);
      },
      async remove() {
        const r = await exec('security', ['delete-generic-password', '-s', service, '-a', ACCOUNT]);
        if (r.code !== 0 && r.code !== 44) throw new Error(`security delete-generic-password: ${r.code}`);
      },
    };
  }

  if (platform === 'linux') {
    const attrs = ['service', service, 'username', ACCOUNT, 'target', 'default', 'application', 'rust-keyring'];
    return {
      service,
      async get() {
        const r = await exec('secret-tool', ['lookup', ...attrs]);
        if (r.code === 0) return r.stdout.trim() || null;
        if (r.code === 1 && !r.stderr.trim()) return null; // nothing matched
        throw new Error(`secret-tool lookup: ${r.code}`);
      },
      async exists() {
        return Boolean(await this.get());
      },
      async set(key) {
        const label = `${ACCOUNT}@${service}:default (capri migration)`;
        const r = await exec('secret-tool', ['store', `--label=${label}`, ...attrs], { input: key });
        if (r.code !== 0) throw new Error(`secret-tool store: ${r.code}`);
      },
      async remove() {
        const r = await exec('secret-tool', ['clear', ...attrs]);
        if (r.code !== 0 && r.code !== 1) throw new Error(`secret-tool clear: ${r.code}`);
      },
    };
  }

  if (platform === 'win32') {
    const target = `${ACCOUNT}.${service}`;
    return {
      service,
      // cmdkey cannot show a secret: "is there one" is all it can tell
      async get() {
        if (await this.exists()) throw Object.assign(new Error('an item already exists and cmdkey cannot read it'), { code: 'unreadable' });
        return null;
      },
      async exists() {
        const r = await exec('cmdkey', [`/list:${target}`]);
        return r.code === 0 && r.stdout.toLowerCase().includes(target.toLowerCase());
      },
      async set(key) {
        const r = await exec('cmdkey', [`/generic:${target}`, `/user:${ACCOUNT}`, `/pass:${key}`]);
        if (r.code !== 0) throw new Error(`cmdkey: ${r.code}`);
      },
      async remove() {
        const r = await exec('cmdkey', [`/delete:${target}`]);
        if (r.code !== 0) throw new Error(`cmdkey /delete: ${r.code}`);
      },
    };
  }

  return null; // no known tool on this system
}

module.exports = { SERVICE, ACCOUNT, serviceName, createCliKeyStore, run };
