'use strict';

// Which of her languages she speaks. Pure: the system's languages are passed in (the platform asks the system),
// so the choice can be tested without an app.

// 'ru-RU', 'en_US', 'pt-BR', 'zh-Hans-CN', 'en-US.UTF-8' -> 'ru', 'en', 'pt', 'zh', 'en' ('' when nothing usable)
function langBase(tag) {
  if (typeof tag !== 'string') return '';
  const base = tag.trim().toLowerCase().split(/[-_.@]/)[0];
  return /^[a-z]{2,3}$/.test(base) ? base : '';
}

// The setting kept in the config: one of `langs`, or 'auto' for anything else
// (missing, empty, a language she no longer speaks). A regional value ('pt-BR') counts as its language.
function langSetting(setting, langs) {
  const base = langBase(setting);
  return langs.includes(base) ? base : 'auto';
}

// The first of the system's languages she speaks, English when she speaks none of them.
// `preferred`: the system's ordered preference list; `fallback`: the locale(s) to try only when that list is empty.
function systemLang(preferred, fallback, langs) {
  const list = (preferred || []).filter((tag) => langBase(tag));
  for (const tag of list.length ? list : fallback || []) {
    const base = langBase(tag);
    if (langs.includes(base)) return base;
  }
  return langs.includes('en') ? 'en' : langs[0];
}

// The language she speaks: the user's choice when it's one of hers, the system's otherwise.
function resolveLang(setting, system, langs) {
  const chosen = langSetting(setting, langs);
  return chosen === 'auto' ? systemLang(system?.preferred, system?.fallback, langs) : chosen;
}

module.exports = { langBase, langSetting, systemLang, resolveLang };
