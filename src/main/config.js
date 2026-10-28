'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  scale: 0.6,        // sprite scale, 0.6 ≈ 250px tall
  muted: false,
  volume: 0.7,
  lang: 'auto',      // 'auto' follows the system language (English if she speaks none of them), or 'fr' / 'en' / 'es' / 'pt' / 'ru'
  displayId: null,   // null = primary display
  wander: true,      // random teleports when idle
  possess: true,     // now and then she dives into the window she sits on and takes it over
  visible: true,
  welcomed: false,   // she has introduced herself (her welcome panel)
  assistant: 'auto', // the coding assistant she watches: 'claude' or 'codex' ('auto': whichever has her hooks)
  linked: false,     // a Claude Code event has reached her at least once
  chatModel: null,   // the model she talks with (null: the provider's first one)
  provider: 'ollama', // who answers her chat: a key of llm.js PROVIDERS
  apiKeys: {},       // { openai: 'sk-...' }, else the provider's env variable
  customUrl: '',     // the 'custom' provider: any OpenAI-compatible base URL (http://host:port/v1)
  claudeCwd: null,   // the folder Claude Code works in (null: your home folder)
  userName: '',      // what she calls you
  persona: '',       // how you want her, in your words (her chat)
  myLines: [],       // lines of yours she says now and then, with hers
  memories: [],      // things you asked her to remember (her chat)
  claudeMode: 'default', // Claude Code's permission mode in her chat: 'default' only reads, 'acceptEdits' edits without asking
  claude: true,      // she watches Claude Code (off: she just keeps you company, no word of it)
  rest: 'corner',    // where she rests when nothing's going on: 'corner', or 'taskbar' (sitting on it)
  motion: 'auto',    // her animations: 'auto' (like Windows' animation effects), 'full' or 'reduced'
  motionAsked: false, // she asked once, Windows' animations being off, whether to move anyway
  render: 'auto',   // how her window is drawn: 'auto', 'gl' (OpenGL) or 'software' (no graphics card), for PCs that show it black
  follow: true,      // with several screens, she follows the pointer to the one you're on
  jealous: true,     // she gets jealous when she sees you on another AI (bond.js)
  reminders: [],     // the reminders she keeps: [{ id, at, text, made }] (reminders.js)
  bond: null,        // how close she is to you: { xp, first, last, days, streak, caps } (bond.js)
  initiative: 'normal', // how much she speaks up on her own: 'quiet', 'normal' or 'active' (initiative.js); never errors, prompts, reminders or answers
  pcReact: true,     // she reacts to your PC: the processor at full tilt, the battery, the network, a USB stick, a game (pc.js)
  watchScreen: false, // she looks at your screen now and then and says something about it (look.js)
  lookAsked: false,  // she told you what looking means (where the picture goes) and you said yes
};

// The config of this computer, kept in the platform's user data folder (platform/index.js).
function createConfig({ platform }) {
  let cache = null;

  function file() {
    return path.join(platform.paths.get('userData'), 'config.json');
  }

  function load(fresh = false) {
    if (cache && !fresh) return cache;
    try {
      cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file(), 'utf8')) };
    } catch {
      cache = { ...DEFAULTS };
    }
    return cache;
  }

  // Written whole to a file beside it, then moved over it: a crash or a full disk mid-write never
  // leaves half a config behind. Throws when it can't be written.
  function write(next) {
    const target = file();
    const temp = `${target}.tmp`;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const text = JSON.stringify(next, null, 2);
      fs.writeFileSync(temp, text);
      try {
        fs.renameSync(temp, target);
      } catch (err) {
        // Windows: an antivirus or the search indexer holding the file open refuses the move over it
        // (EPERM, EACCES, EBUSY). Written in place then, as it always was, rather than not at all.
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) throw err;
        fs.writeFileSync(target, text);
        fs.rmSync(temp, { force: true });
      }
    } catch (err) {
      try {
        fs.rmSync(temp, { force: true });
      } catch {
        // nothing more to clean up
      }
      throw err;
    }
  }

  // Changes kept even when the file can't be written (the error is logged): what her menu and the
  // overlay have always done, so she goes on as asked until she restarts.
  function save(patch) {
    cache = { ...load(), ...patch };
    try {
      write(cache);
    } catch (err) {
      console.error('[capri] could not save config:', err.message);
    }
    return cache;
  }

  // Changes kept only once they are on disk: when the file can't be written this throws and nothing
  // changes, so a settings window never shows as saved what would be lost at the next start.
  function commit(patch) {
    const next = { ...load(), ...patch };
    write(next);
    cache = next;
    return cache;
  }

  return { load, save, commit, file, DEFAULTS };
}

module.exports = { createConfig, DEFAULTS };
