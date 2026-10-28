# TAURI-03: слой host и проверка в WebKit

Дата: 2026-10-28. Ветка `tauri-03`.

## Слой host

Весь доступ renderer к нативной части теперь в `src/renderer/js/host.js`. Два глагола:

- `invoke(name, args)` — команда; `args` массив позиционных аргументов (`invoke('closeApp', [name, force])`), возвращает ответ;
- `on(event, cb)` — событие (`'capri:config'`, `'claude:event'`, `'settings:view'` ...), возвращает функцию отписки.

Модуль экспортирует два объекта: `host` (overlay) и `settingsHost` (окно настроек). У каждого есть те же именованные помощники, что были у preload (`host.setConfig(patch)`, `host.onConfig(cb)`, `settingsHost.updates.check()`), поэтому остальной renderer не менялся: модули получают `host` параметром, а прямое обращение к глобалу было только в `app.js` и `settings.js`.

Реализация выбирается при первом вызове:

1. `window.__CAPRI_HOST__` (`{ overlay: {invoke,on}, settings: {invoke,on} }` или просто `{invoke,on}`) — сюда встанет Tauri-мост из TAURI-04 и фейковый host проверки.
2. `window.__TAURI__.core` — общий мост: одна Rust-команда `host_invoke { scope, name, args }`, события `capri://<event>`. **Это заготовка: Rust-стороны ещё нет, не проверялась.**
3. Electron: `window.host` / `window.settingsHost` из preload, вызов по имени метода. Preload, каналы и main не менялись.

Тест-страж `tests/host-guard.test.js`: вне `host.js` в `src/renderer` нет `window.host`, `settingsHost`, `capriSettings`, `__CAPRI_HOST__`, `__TAURI__`, `ipcRenderer`, `require('electron')`; `app.js` и `settings.js` импортируют `host.js`; все методы preload есть в `host`, а `invoke`/`on` доходят до подставленной реализации.

## Проверка в WebKit

Движок: настоящий WKWebView этого Mac (macOS 26 / Darwin 25.6, arm64; UA `AppleWebKit/605.1.15`). Выбран вариант с маленьким Swift-приложением `tools/webkit-check/wkcheck.swift` (`swiftc`, без Xcode): грузит страницу, перехватывает console.* / ошибки / unhandledrejection / нарушения CSP / не загрузившиеся ресурсы, выполняет пробный скрипт, делает `takeSnapshot` в PNG, считает непрозрачные пиксели в прямоугольнике. С `--transparent` у web view отключён фон, как у прозрачного overlay.

- `tools/webkit-check/server.js` — статический сервер без зависимостей; отдаёт репозиторий как есть (пути, CSS, шрифты, CSP не тронуты). При `?fake=1` в страницу добавляются `fake-host.js` и данные `/__fake/data.js`. Вид настроек — настоящий `settings-view.js` на тестовых фактах.
- `tools/webkit-check/fake-host.js` — фейковый host (конфиг, 2 экрана, view настроек, логирует команды; `window.__fakeEmit(scope, event, payload)` шлёт события).
- `npm run check:webkit` (`tools/webkit-check/run.js`) — запускает обе страницы, падает при ошибках в консоли или если спрайт не нарисован.

Скриншоты `npm run check:webkit` кладёт в `tools/webkit-check/out/` (не в git; ниже описаны снимки, сделанные при первом прогоне, их файлов в репозитории нет: `settings.png`, `overlay.png` — установившийся кадр, `overlay-entrance-glitch.png` — кадр на 4-й секунде, во время входного глитча, `overlay-event.png` — после событий).

Результаты (WKWebView):

| Что | Итог |
|---|---|
| Окно настроек 1280x800 (@2x) | отрисовано полностью: `@import tokens.css`, шрифты Chakra Petch / JetBrains Mono (woff2 из node_modules), `clip-path` на кнопках/плитках/ползунке, `mask-image` (razor-края), `::-webkit-slider-*`, `:has()`, `oklch()` — всё как в Chromium на глаз |
| Консоль настроек и overlay | 0 ошибок, 0 нарушений CSP, ресурсы загружены |
| WebGL overlay | `getContext('webgl')` даёт WebGL 1.0, контекст не потерян, `getError()`=0, 39 расширений; спрайт: 83 335 из 246 448 пикселей (alpha>16) в прямоугольнике канваса 211x319 pt (при 2x) — нарисован; после входной анимации (14 с) кадр чистый |
| Прозрачность | при отключённом фоне web view вне спрайта alpha=0 в PNG |
| Аудио | `new AudioContext()` создаётся, граф osc→gain→destination строится, `resume()` без ошибок; состояние `suspended` до жеста (код voice.js уже делает `resume()`) |
| События host | `claude:event`, `power:state`, `capri:command {status}` через фейк доходят; панель показала ответ статуса |
| API | `structuredClone`, `Intl.Segmenter`, `CSS.escape`, regexp с look-behind (reminders.js, bond.js) — работают |

## Найденные несовместимости и исправления

- `voice.js`: `new AudioContext()` -> `new (window.AudioContext || window.webkitAudioContext)()`. В современном WebKit префикса нет, это страховка для старого системного WebKit. Для Electron ничего не меняется.
- Остальное из списка (CSS-префиксы, WebGL-расширения, `structuredClone`, `Intl`) в этом WebKit работает без правок. `getBattery` в Safari нет, но `pc.js` вызывает его через `?.` и обрабатывает отсутствие.
- Скриншот во время входной анимации (глитч спрайта) выглядит «битым» — это сама анимация, а не баг WebKit (через ~14 с кадр чистый).

## Не проверено

- **WebKitGTK (Linux): не запускалось.** Готовы `.github/workflows/webkit-check.yml` (только `workflow_dispatch`; ubuntu-24.04, `xvfb`, `gir1.2-webkit2-4.1`, `python3-gi`, софт-рендер Mesa `LIBGL_ALWAYS_SOFTWARE=1`) и `tools/webkit-check/wkgtk-check.py` (GTK OffscreenWindow + WebKit2 4.1, печатает консоль/ошибки, пробный скрипт, PNG, код возврата). Скрипт (py_compile) и YAML (парсер) проверены только синтаксически; API WebKit2 4.1 из скрипта не исполнялся. Неизвестно: поднимется ли WebGL под Xvfb с llvmpipe, прозрачность окна, поведение mask/clip-path в версии webkit2gtk Ubuntu 24.04 (2.4x). Запустить вручную и приложить артефакт `webkitgtk-screenshots`.
- Windows WebView2 — Chromium, отдельно не проверялось.
- Версии WebKit старше установленной: используются look-behind в регулярках и `oklch()`; они требуют Safari 16.4 / 15.4, то есть macOS с таким системным WebKit. Минимальную версию macOS для Tauri-сборки надо зафиксировать в TAURI-04/12.
- Реальная прозрачность окна Tauri (`macOSPrivateApi`), пропуск кликов, звук после жеста пользователя в Tauri-окне, `window.__TAURI__`-мост — зона TAURI-00/04/05.
- Проверка шла против фейкового host: каналы реальных команд (`config:set` и др.) не гонялись через WebKit.
