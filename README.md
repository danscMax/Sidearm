<div align="center">

# Sidearm

**Your mouse buttons, your rules.**

Desktop workflow studio for multi-button mice.
Turn 36 buttons into a personal command center.

[**English**](#-what-is-sidearm) | [**Русский**](#-что-такое-sidearm)

---

</div>

## EN What is Sidearm?

Sidearm is a **desktop app** that transforms multi-button mice (like the Razer Naga) into a powerful productivity tool. Assign keyboard shortcuts, text snippets, macros, app launchers, and more to every button -- with automatic profile switching based on which application is in focus.

Built with **Tauri v2** (Rust backend + React frontend). Runs natively on Windows with minimal resource usage.

### Why?

Gaming mice have 12+ thumb buttons that go unused outside of games. Sidearm lets you put every single button to work -- differently in each app. Excel gets one set of shortcuts, VS Code gets another, your browser gets a third. Switching is automatic.

### Features

- **36 interceptable buttons** -- 12 thumb grid + 5 top panel + scroll wheel + Hypershift layer doubles everything
- **9 action types** -- keyboard shortcuts, mouse actions, text snippets, macro sequences, app launch, media keys, profile switching, context menus
- **Per-app profiles** -- automatic profile switching when you Alt+Tab between applications
- **Two layers** -- Standard + Hypershift: each button can have two completely different bindings
- **Macro recorder** -- record keystroke sequences with timing, edit delays, add text and launch steps
- **Live diagnostics** -- test any button binding without leaving the app, see signal flow in real time
- **Verification session** -- step-by-step hardware verification of every button mapping
- **Heatmap** -- see which buttons you actually use (execution count overlay)
- **Structured logging** -- persistent log files with rotation, real-time log viewer with filters
- **Crash detection** -- sentinel file detects abnormal terminations, logs previous session info
- **Custom titlebar** -- fully themed, no native chrome
- **Portable** -- single .exe, no installer required

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Rust, Windows API (`windows-sys`), low-level keyboard hooks |
| Frontend | React 19, TypeScript, Vite 8 |
| Framework | Tauri v2 (single process, no Electron) |
| Logging | `tauri-plugin-log` v2 (file + webview + stdout) |
| Build | `cargo tauri build`, portable build script |

### Getting Started

```bash
# Prerequisites: Node.js 20+, Rust 1.77+, Windows 10/11

# Install dependencies
npm install

# Development
cargo tauri dev

# Portable build
.\build_portable.bat
```

### How It Works

```
Mouse button press
    -> Windows LL keyboard hook intercepts the signal
    -> Resolver matches: which app is focused? which profile? which button?
    -> Executor fires the bound action (keystrokes, text, launch, etc.)
    -> UI updates in real time (diagnostics, heatmap, logs)
```

### Screenshots

*Coming soon*

---

<div align="center">

## RU Что такое Sidearm?

</div>

Sidearm -- **десктопное приложение**, которое превращает многокнопочные мыши (например, Razer Naga) в мощный инструмент продуктивности. Назначайте клавиатурные сочетания, текстовые фрагменты, макросы, запуск приложений и многое другое на каждую кнопку -- с автоматическим переключением профилей в зависимости от активного приложения.

Построен на **Tauri v2** (Rust-бэкенд + React-фронтенд). Работает нативно на Windows с минимальным потреблением ресурсов.

### Зачем?

У игровых мышей 12+ боковых кнопок, которые простаивают вне игр. Sidearm позволяет задействовать каждую кнопку -- по-разному в каждом приложении. В Excel одни шорткаты, в VS Code другие, в браузере третьи. Переключение автоматическое.

### Возможности

- **36 перехватываемых кнопок** -- 12 боковых + 5 верхних + колесо + слой Hypershift удваивает все
- **9 типов действий** -- клавиатурные сочетания, действия мыши, текстовые вставки, макросы, запуск приложений, медиа-клавиши, переключение профилей, контекстные меню
- **Профили по приложениям** -- автоматическое переключение при Alt+Tab между окнами
- **Два слоя** -- Стандартный + Hypershift: каждая кнопка может иметь два совершенно разных назначения
- **Запись макросов** -- запись последовательностей нажатий с таймингами, редактирование задержек, добавление текста и команд запуска
- **Живая диагностика** -- тестируйте привязку любой кнопки не выходя из приложения, наблюдайте поток сигналов в реальном времени
- **Сессия проверки** -- пошаговая аппаратная верификация каждого назначения кнопки
- **Тепловая карта** -- показывает, какие кнопки вы реально используете (счетчик нажатий)
- **Структурированное логирование** -- лог-файлы с ротацией, просмотрщик логов в реальном времени с фильтрами
- **Обнаружение крашей** -- sentinel-файл детектирует аварийные завершения
- **Кастомный тайтлбар** -- полностью стилизован под приложение
- **Портативная сборка** -- один .exe, установщик не требуется

### Технологии

| Слой | Технология |
|------|-----------|
| Бэкенд | Rust, Windows API (`windows-sys`), низкоуровневые хуки клавиатуры |
| Фронтенд | React 19, TypeScript, Vite 8 |
| Фреймворк | Tauri v2 (один процесс, без Electron) |
| Логирование | `tauri-plugin-log` v2 (файл + webview + stdout) |
| Сборка | `cargo tauri build`, скрипт портативной сборки |

### Быстрый старт

```bash
# Требования: Node.js 20+, Rust 1.77+, Windows 10/11

# Установить зависимости
npm install

# Разработка
cargo tauri dev

# Портативная сборка
.\build_portable.bat
```

### Как это работает

```
Нажатие кнопки мыши
    -> Windows LL keyboard hook перехватывает сигнал
    -> Резолвер определяет: какое приложение активно? какой профиль? какая кнопка?
    -> Экзекьютор выполняет привязанное действие (нажатия, текст, запуск и т.д.)
    -> UI обновляется в реальном времени (диагностика, тепловая карта, логи)
```

---

<div align="center">

### License

MIT

</div>
