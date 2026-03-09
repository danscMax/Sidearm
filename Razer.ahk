#Requires AutoHotkey v2.0
#SingleInstance Force
Persistent

global APP_NAME := "Razer Naga Studio v3"
global CFG_DIR := A_ScriptDir "\config"
global CFG_ACTIONS := CFG_DIR "\actions.ini"
global CFG_APPS := CFG_DIR "\apps.ini"
global CFG_SETTINGS := CFG_DIR "\settings.ini"

global gGui := 0
global gTab := 0
global gCtl := Map()
global gProfiles := []
global gStdMap := Map()
global gHsMap := Map()
global gAllHotkeys := []
global gSelectedProfile := "Default"
global gSelectedLayer := "STD"
global gSelectedSlot := 1
global gOverrideProfile := ""
global gDebugLines := []
global gCaptureTarget := ""
global gPendingWinCapture := false

Init()

Init() {
    EnsureDirs()
    BuildHotkeyMaps()
    EnsureIni()
    ImportMyPresetProfiles()
    LoadProfiles()
    BuildGui()
    BuildTray()
    RegisterHotkeys()
    RefreshAll()
    ShowMainGui()
}

EnsureDirs() {
    global CFG_DIR
    if !DirExist(CFG_DIR)
        DirCreate(CFG_DIR)
}

BuildHotkeyMaps() {
    global gStdMap, gHsMap, gAllHotkeys
    gStdMap := Map()
    gHsMap := Map()
    gAllHotkeys := []

    Loop 12 {
        slot := A_Index
        hk := "F" (12 + slot)
        gStdMap[slot] := hk
        gAllHotkeys.Push(Map("layer", "STD", "slot", slot, "hotkey", hk))
    }

    Loop 12 {
        slot := A_Index
        hk := "^!+F" (12 + slot)
        gHsMap[slot] := hk
        gAllHotkeys.Push(Map("layer", "HS", "slot", slot, "hotkey", hk))
    }
}

EnsureIni() {
    global CFG_SETTINGS, CFG_APPS, CFG_ACTIONS

    if !FileExist(CFG_SETTINGS) {
        IniWrite("Default", CFG_SETTINGS, "General", "FallbackProfile")
        IniWrite("1", CFG_SETTINGS, "General", "UseClipboardRestore")
        IniWrite("1", CFG_SETTINGS, "General", "ShowTrayNotifications")
        IniWrite("1", CFG_SETTINGS, "General", "LightTheme")
    }

    if !FileExist(CFG_APPS) {
        IniWrite("Code", CFG_APPS, "Apps", "code.exe")
        IniWrite("Code", CFG_APPS, "Apps", "cursor.exe")
        IniWrite("Browser", CFG_APPS, "Apps", "chrome.exe")
        IniWrite("Browser", CFG_APPS, "Apps", "msedge.exe")
        IniWrite("Browser", CFG_APPS, "Apps", "firefox.exe")
        IniWrite("Terminal", CFG_APPS, "Apps", "windowsterminal.exe")
        IniWrite("Terminal", CFG_APPS, "Apps", "pwsh.exe")
        IniWrite("Terminal", CFG_APPS, "Apps", "cmd.exe")
        IniWrite("Telegram", CFG_APPS, "Apps", "telegram.exe")
        IniWrite("Writing", CFG_APPS, "Apps", "notepad++.exe")
    }

    if !FileExist(CFG_ACTIONS) {
        SeedDefaults()
    }
}

SeedDefaults() {
    SeedAction("Default", "STD", 1, "Copy", "Shortcut", "^c", "")
    SeedAction("Default", "STD", 2, "Paste", "Shortcut", "^v", "")
    SeedAction("Default", "STD", 3, "Find", "Shortcut", "^f", "")
    SeedAction("Default", "STD", 4, "Undo", "Shortcut", "^z", "")
    SeedAction("Default", "STD", 5, "Save", "Shortcut", "^s", "")
    SeedAction("Default", "STD", 6, "Close tab", "Shortcut", "^w", "")
}

ImportMyPresetProfiles() {
    ; Безопасный импорт только если секций еще нет
    ; MAIN и Code частично заполняются на основе ваших скринов

    if !SectionExists("Main", "STD", 1) {
        SeedAction("Main", "STD", 1, "Delete", "Shortcut", "{Delete}", "")
        SeedAction("Main", "STD", 2, "Backspace", "Shortcut", "{Backspace}", "")
        SeedAction("Main", "STD", 3, "Shift+F3", "Shortcut", "+{F3}", "")
        SeedAction("Main", "STD", 4, "Find", "Shortcut", "^f", "")
        SeedAction("Main", "STD", 5, "Save", "Shortcut", "^s", "")
        SeedAction("Main", "STD", 6, "Undo", "Shortcut", "^z", "")
        SeedAction("Main", "STD", 7, "Close App", "Shortcut", "!{F4}", "")
        SeedAction("Main", "STD", 8, "Enter", "Shortcut", "{Enter}", "")
        SeedAction("Main", "STD", 9, "Copy", "Shortcut", "^c", "")
        SeedAction("Main", "STD", 10, "Close tab", "Shortcut", "^w", "")
        SeedAction("Main", "STD", 11, "Space", "Shortcut", "{Space}", "")
        SeedAction("Main", "STD", 12, "Paste", "Shortcut", "^v", "")

        SeedAction("Main", "HS", 1, "Minus", "Shortcut", "-", "")
        SeedAction("Main", "HS", 2, "Ctrl+Shift+=", "Shortcut", "^+=", "")
        SeedAction("Main", "HS", 3, "Alt+Ctrl+Shift+R", "Shortcut", "!^+r", "")
        SeedAction("Main", "HS", 4, "Ctrl+H", "Shortcut", "^h", "")
        SeedAction("Main", "HS", 5, "RightCtrl+RightShift+-", "Text snippet", "Right Ctrl + Right Shift + -", "")
        SeedAction("Main", "HS", 6, "Ctrl+Y", "Shortcut", "^y", "")
        SeedAction("Main", "HS", 7, "Alt+Ctrl+Shift+I", "Shortcut", "!^+i", "")
        SeedAction("Main", "HS", 8, "Shift+Enter", "Shortcut", "+{Enter}", "")
        SeedAction("Main", "HS", 9, "Copy no paragraphs", "Text snippet", "Копировать без параграфов", "")
        SeedAction("Main", "HS", 10, "Ctrl+Shift+T", "Shortcut", "^+t", "")
        SeedAction("Main", "HS", 11, "Ctrl+Shift+8", "Shortcut", "^+8", "")
        SeedAction("Main", "HS", 12, "Win+V", "Shortcut", "#v", "")
    }

    if !SectionExists("Code", "STD", 1) {
        SeedAction("Code", "STD", 1, "Delete", "Shortcut", "{Delete}", "")
        SeedAction("Code", "STD", 2, "Backspace", "Shortcut", "{Backspace}", "")
        SeedAction("Code", "STD", 3, "Validation", "Text snippet", "Проверь валидацию, null, empty, edge cases, race conditions", "")
        SeedAction("Code", "STD", 4, "Find", "Shortcut", "^f", "")
        SeedAction("Code", "STD", 5, "Save", "Shortcut", "^s", "")
        SeedAction("Code", "STD", 6, "Undo", "Shortcut", "^z", "")
        SeedAction("Code", "STD", 7, "Close App", "Shortcut", "!{F4}", "")
        SeedAction("Code", "STD", 8, "Enter", "Shortcut", "{Enter}", "")
        SeedAction("Code", "STD", 9, "Copy", "Shortcut", "^c", "")
        SeedAction("Code", "STD", 10, "Close tab", "Shortcut", "^w", "")
        SeedAction("Code", "STD", 11, "Space", "Shortcut", "{Space}", "")
        SeedAction("Code", "STD", 12, "Paste", "Shortcut", "^v", "")

        SeedAction("Code", "HS", 1, "Ask Me", "Text snippet", "Спроси меня", "")
        SeedAction("Code", "HS", 2, "Agents", "Text snippet", "Агенты для анализа", "")
        SeedAction("Code", "HS", 3, "Best Practices", "Text snippet", "Best Practices", "")
        SeedAction("Code", "HS", 4, "Resume", "Text snippet", "/resume", "")
        SeedAction("Code", "HS", 5, "Max", "Text snippet", "/max", "")
        SeedAction("Code", "HS", 6, "Agent Team", "Text snippet", "Agent Team", "")
        SeedAction("Code", "HS", 7, "Danger Skip", "Text snippet", "dangerously-skip-permissions-check", "")
        SeedAction("Code", "HS", 8, "Shift+Enter", "Shortcut", "+{Enter}", "")
        SeedAction("Code", "HS", 9, "Fix by GOS", "Text snippet", "предложи правильный fix по ГОС", "")
        SeedAction("Code", "HS", 10, "Shift+Tab", "Shortcut", "+{Tab}", "")
        SeedAction("Code", "HS", 11, "Danger Bypass", "Text snippet", "dangerously-bypass-approvals-and-restrictions", "")
        SeedAction("Code", "HS", 12, "Paste Win", "Shortcut", "#v", "")
    }
}

SectionExists(profile, layer, slot) {
    global CFG_ACTIONS
    sec := profile "." layer "." slot
    val := IniRead(CFG_ACTIONS, sec, "Type", "")
    return (val != "")
}

SeedAction(profile, layer, slot, label, type, value, notes) {
    global CFG_ACTIONS
    sec := profile "." layer "." slot
    IniWrite(label, CFG_ACTIONS, sec, "Label")
    IniWrite(type, CFG_ACTIONS, sec, "Type")
    IniWrite(value, CFG_ACTIONS, sec, "Value")
    IniWrite(notes, CFG_ACTIONS, sec, "Notes")
}

LoadProfiles() {
    global gProfiles, CFG_ACTIONS
    gProfiles := []
    txt := FileRead(CFG_ACTIONS, "UTF-8")
    seen := Map()

    for line in StrSplit(txt, "`n", "`r") {
        line := Trim(line)
        if !RegExMatch(line, "^\[(.+)\]$", &m)
            continue
        sec := m[1]
        parts := StrSplit(sec, ".")
        if (parts.Length >= 3) {
            p := parts[1]
            if !seen.Has(p) {
                seen[p] := 1
                gProfiles.Push(p)
            }
        }
    }

    if (gProfiles.Length = 0)
        gProfiles := ["Default", "Main", "Code", "Browser", "Terminal", "Telegram", "Writing"]
}

BuildGui() {
    global gGui, gTab, gCtl, gProfiles

    gGui := Gui("+Resize +MinSize1440x940", APP_NAME)
    gGui.BackColor := "F3F7F2"
    gGui.SetFont("s10", "Segoe UI")

    gGui.AddText("x20 y18 w60 c202020", "Профиль")
    gCtl["ProfileDDL"] := gGui.AddDropDownList("x85 y14 w210", gProfiles)
    gCtl["ProfileDDL"].Text := "Default"
    gCtl["ProfileDDL"].OnEvent("Change", OnProfileChanged)

    gGui.AddText("x320 y18 w160 c202020", "Активное приложение")
    gCtl["ActiveApp"] := gGui.AddEdit("x480 y14 w350 ReadOnly")

    gGui.AddButton("x850 y12 w140 h32", "Определить окно").OnEvent("Click", (*) => BeginWindowCapture())
    gGui.AddButton("x1005 y12 w120 h32", "Сохранить").OnEvent("Click", (*) => SaveCurrentEditor())
    gGui.AddButton("x1140 y12 w130 h32", "Новый профиль").OnEvent("Click", (*) => CreateNewProfile())
    gGui.AddButton("x1285 y12 w120 h32", "Отладчик").OnEvent("Click", (*) => FocusDebugTab())

    gTab := gGui.AddTab3("x20 y55 w1390 h845", ["Buttons", "Mappings", "All Actions", "Debug"])

    gTab.UseTab(1)
    BuildButtonsTabV3()

    gTab.UseTab(2)
    BuildMappingsTab()

    gTab.UseTab(3)
    BuildActionsTab()

    gTab.UseTab(4)
    BuildDebugTab()

    gTab.UseTab()

    gGui.OnEvent("Close", (*) => gGui.Hide())
}

BuildButtonsTabV3() {
    global gGui, gCtl

    gGui.AddGroupBox("x35 y95 w560 h720 c4B5F4A", "Стандартный слой")
    gGui.AddGroupBox("x610 y95 w560 h720 c4B5F4A", "Hypershift слой")
    gGui.AddGroupBox("x1185 y95 w210 h720 c4B5F4A", "Редактор")

    BuildTileColumnV3("STD", 1, 6, 55, 130, 250)
    BuildTileColumnV3("STD", 7, 12, 320, 130, 250)

    BuildTileColumnV3("HS", 1, 6, 630, 130, 250)
    BuildTileColumnV3("HS", 7, 12, 895, 130, 250)

    gGui.AddText("x1200 y128 w160 c202020", "Выбранная кнопка")
    gCtl["EditorSlot"] := gGui.AddEdit("x1200 y152 w180 ReadOnly")

    gGui.AddText("x1200 y192 w160 c202020", "Название")
    gCtl["EditorLabel"] := gGui.AddEdit("x1200 y216 w180")

    gGui.AddText("x1200 y256 w160 c202020", "Тип действия")
    gCtl["EditorMode"] := gGui.AddDropDownList("x1200 y280 w180", ["Disabled", "Shortcut", "Text snippet", "Sequence", "Launch", "Menu"])
    gCtl["EditorMode"].OnEvent("Change", OnEditorModeChanged)

    gGui.AddText("x1200 y320 w160 c202020", "Отображение")
    gCtl["PrettyValue"] := gGui.AddEdit("x1200 y344 w180 ReadOnly")

    gGui.AddGroupBox("x1195 y380 w190 h165 c7ABF45", "Shortcut editor")
    gGui.AddButton("x1210 y405 w170 h32", "Record").OnEvent("Click", (*) => BeginHotkeyRecord())
    gCtl["SC_Ctrl"] := gGui.AddCheckbox("x1210 y448 w55 c202020", "Ctrl")
    gCtl["SC_Shift"] := gGui.AddCheckbox("x1270 y448 w60 c202020", "Shift")
    gCtl["SC_Alt"] := gGui.AddCheckbox("x1335 y448 w45 c202020", "Alt")
    gCtl["SC_Win"] := gGui.AddCheckbox("x1210 y476 w55 c202020", "Win")
    gGui.AddText("x1210 y510 w60 c202020", "Клавиша")
    gCtl["SC_Key"] := gGui.AddDropDownList("x1265 y506 w115", BuildMainKeyList())
    gGui.AddButton("x1210 y540 w170 h28", "Собрать Shortcut").OnEvent("Click", (*) => BuildShortcutFromControls())

    gGui.AddGroupBox("x1195 y555 w190 h130 c7ABF45", "Данные")
    gGui.AddText("x1210 y580 w160 c202020", "Значение")
    gCtl["EditorValue"] := gGui.AddEdit("x1210 y604 w170 h70 WantTab")
    gGui.AddText("x1210 y682 w160 c202020", "Notes")
    gCtl["EditorNotes"] := gGui.AddEdit("x1210 y706 w170 h60")

    gGui.AddButton("x1200 y780 w84 h34", "Тест").OnEvent("Click", (*) => TestCurrentEditorAction())
    gGui.AddButton("x1296 y780 w84 h34", "Очистить").OnEvent("Click", (*) => ClearEditor())
    gGui.AddButton("x1200 y824 w180 h34", "Сохранить кнопку").OnEvent("Click", (*) => SaveCurrentEditor())

    gGui.AddText("x50 y830 w1120 c5C6C58", "Подсказка: Shortcut хранится как AHK-строка, но показывается по-человечески. Record записывает то, что вы нажали.")
}

BuildTileColumnV3(layer, fromSlot, toSlot, x, y, w) {
    global gGui, gCtl
    row := 0
    Loop (toSlot - fromSlot + 1) {
        slot := fromSlot + A_Index - 1
        yy := y + row * 108
        txt := MakeTileCaptionV3(layer, slot)
        btn := gGui.AddButton("x" x " y" yy " w" w " h84", txt)
        btn.OnEvent("Click", OnTileClick.Bind(layer, slot))
        gCtl["TILE_" layer "_" slot] := btn
        row += 1
    }
}

BuildMappingsTab() {
    global gGui, gCtl, gProfiles

    gGui.AddText("x45 y105 w40 c202020", "EXE")
    gCtl["MapExe"] := gGui.AddEdit("x90 y101 w260")

    gGui.AddText("x370 y105 w60 c202020", "Профиль")
    gCtl["MapProf"] := gGui.AddDropDownList("x430 y101 w180", gProfiles)

    gGui.AddButton("x630 y99 w120 h32", "Добавить").OnEvent("Click", (*) => AddMapping())
    gGui.AddButton("x765 y99 w160 h32", "Удалить выбранное").OnEvent("Click", (*) => DeleteSelectedMapping())
    gGui.AddButton("x940 y99 w140 h32", "Обновить").OnEvent("Click", (*) => RefreshMappings())
    gGui.AddButton("x1095 y99 w190 h32", "Захватить текущее окно").OnEvent("Click", (*) => BeginWindowCapture("Mapping"))

    gCtl["MappingsLV"] := gGui.AddListView("x45 y150 w1320 h680 Grid", ["EXE", "Профиль"])
}

BuildActionsTab() {
    global gGui, gCtl
    gGui.AddButton("x45 y100 w160 h32", "Обновить таблицу").OnEvent("Click", (*) => RefreshActionsTable())
    gGui.AddButton("x220 y100 w230 h32", "Загрузить выбранное в редактор").OnEvent("Click", (*) => LoadSelectedAction())
    gCtl["ActionsLV"] := gGui.AddListView("x45 y150 w1320 h680 Grid", ["Профиль", "Слой", "Кнопка", "Label", "Тип", "Значение", "Отображение"])
}

BuildDebugTab() {
    global gGui, gCtl
    gGui.AddButton("x45 y100 w140 h32", "Очистить лог").OnEvent("Click", (*) => ClearDebug())
    gGui.AddButton("x200 y100 w170 h32", "Показать профиль").OnEvent("Click", (*) => ShowCurrentProfile())
    gGui.AddButton("x385 y100 w220 h32", "Записать текущее окно").OnEvent("Click", (*) => LogActiveWindow())
    gCtl["DebugBox"] := gGui.AddEdit("x45 y150 w1320 h680 ReadOnly WantTab")
}

BuildTray() {
    A_TrayMenu.Delete()
    A_TrayMenu.Add("Открыть Studio", (*) => ShowMainGui())
    A_TrayMenu.Add("Показать активный профиль", (*) => ShowCurrentProfile())
    A_TrayMenu.Add("Reload", (*) => Reload())
    A_TrayMenu.Add("Выход", (*) => ExitApp())
    A_TrayMenu.Default := "Открыть Studio"
    A_TrayMenu.ClickCount := 1
    A_IconTip := APP_NAME
}

RegisterHotkeys() {
    global gAllHotkeys
    for _, item in gAllHotkeys
        Hotkey(item["hotkey"], HandleSideButton)
}

HandleSideButton(hkName) {
    if (gCaptureTarget = "RecordHotkey") {
        SaveRecordedHotkey(hkName)
        return
    }

    meta := FindHotkeyMeta(hkName)
    if !IsObject(meta) {
        DebugLog("Unknown hotkey: " hkName)
        return
    }

    profile := ResolveActiveProfile()
    DebugLog("Pressed " hkName " -> " profile " / " meta["layer"] " / " meta["slot"])
    ExecuteResolvedAction(profile, meta["layer"], meta["slot"])
}

FindHotkeyMeta(hkName) {
    global gAllHotkeys
    for _, item in gAllHotkeys
        if (item["hotkey"] = hkName)
            return item
    return 0
}

ResolveActiveProfile() {
    global gOverrideProfile, CFG_APPS, CFG_SETTINGS

    if (gOverrideProfile != "")
        return gOverrideProfile

    hwnd := WinExist("A")
    exe := ""
    try exe := StrLower(WinGetProcessName("ahk_id " hwnd))

    if (exe != "" && exe != "autohotkey64.exe" && exe != "autohotkey.exe") {
        p := IniRead(CFG_APPS, "Apps", exe, "")
        if (p != "")
            return p
    }

    return IniRead(CFG_SETTINGS, "General", "FallbackProfile", "Default")
}

LoadAction(profile, layer, slot) {
    global CFG_ACTIONS
    sec := profile "." layer "." slot
    return Map(
        "Label", IniRead(CFG_ACTIONS, sec, "Label", ""),
        "Type", IniRead(CFG_ACTIONS, sec, "Type", ""),
        "Value", IniRead(CFG_ACTIONS, sec, "Value", ""),
        "Notes", IniRead(CFG_ACTIONS, sec, "Notes", "")
    )
}

ExecuteResolvedAction(profile, layer, slot) {
    act := LoadAction(profile, layer, slot)
    if (act["Type"] = "" && profile != "Default")
        act := LoadAction("Default", layer, slot)
    if (act["Type"] = "" || act["Type"] = "Disabled") {
        DebugLog("No action for " profile " / " layer " / " slot)
        SoundBeep(900, 40)
        return
    }
    ExecuteAction(act)
}

ExecuteAction(act) {
    type := act["Type"]
    value := act["Value"]

    switch type {
        case "Shortcut":
            Send(value)
        case "Text snippet":
            PasteText(value)
        case "Launch":
            Run(value)
        case "Sequence":
            ExecuteSequence(value)
        case "Menu":
            ShowNamedMenu(value)
        case "Disabled":
            return
        default:
            DebugLog("Unknown action type: " type)
    }
}

PasteText(text) {
    global CFG_SETTINGS
    useRestore := IniRead(CFG_SETTINGS, "General", "UseClipboardRestore", "1")
    if (useRestore = "1") {
        clipSaved := ClipboardAll()
        A_Clipboard := text
        if ClipWait(0.5)
            Send("^v")
        Sleep(60)
        A_Clipboard := clipSaved
    } else {
        SendText(text)
    }
}

ExecuteSequence(seq) {
    lines := StrSplit(seq, "`n", "`r")
    for _, line in lines {
        line := Trim(line)
        if (line = "")
            continue

        if RegExMatch(line, "i)^SEND:(.*)$", &m) {
            Send(Trim(m[1]))
        } else if RegExMatch(line, "i)^TEXT:(.*)$", &m) {
            PasteText(m[1])
        } else if RegExMatch(line, "i)^RUN:(.*)$", &m) {
            Run(Trim(m[1]))
        } else if RegExMatch(line, "i)^SLEEP:(\d+)$", &m) {
            Sleep(Integer(m[1]))
        } else {
            DebugLog("Bad sequence line: " line)
        }
    }
}

ShowNamedMenu(name) {
    menu := Menu()
    switch StrLower(name) {
        case "codeprompts":
            menu.Add("Валидация", (*) => PasteText("Проверь валидацию, null, empty, edge cases"))
            menu.Add("Best Practices", (*) => PasteText("Предложи улучшения по best practices"))
            menu.Add("Security", (*) => PasteText("Проверь security risks, secrets и инъекции"))
        case "telegramquick":
            menu.Add("Короткий ответ", (*) => PasteText("Принял, посмотрю"))
            menu.Add("Развернутый ответ", (*) => PasteText("Спасибо, увидел. Нужен контекст и пример"))
        default:
            menu.Add("Пустое меню", (*) => 0)
    }
    menu.Show()
}

OnProfileChanged(*) {
    global gCtl, gSelectedProfile
    gSelectedProfile := gCtl["ProfileDDL"].Text
    RefreshTiles()
}

OnTileClick(layer, slot, *) {
    global gSelectedLayer, gSelectedSlot, gCtl
    gSelectedLayer := layer
    gSelectedSlot := slot

    act := LoadAction(gCtl["ProfileDDL"].Text, layer, slot)
    gCtl["EditorSlot"].Value := ((layer = "HS") ? "HS+" : "") slot
    gCtl["EditorLabel"].Value := act["Label"]
    gCtl["EditorMode"].Text := act["Type"] != "" ? act["Type"] : "Disabled"
    gCtl["EditorValue"].Value := act["Value"]
    gCtl["EditorNotes"].Value := act["Notes"]
    gCtl["PrettyValue"].Value := PrettyValue(act["Type"], act["Value"])

    LoadShortcutControls(act["Value"])
}

OnEditorModeChanged(*) {
    global gCtl
    gCtl["PrettyValue"].Value := PrettyValue(gCtl["EditorMode"].Text, gCtl["EditorValue"].Text)
}

SaveCurrentEditor() {
    global CFG_ACTIONS, gCtl, gSelectedLayer, gSelectedSlot

    profile := gCtl["ProfileDDL"].Text
    sec := profile "." gSelectedLayer "." gSelectedSlot

    IniWrite(gCtl["EditorLabel"].Text, CFG_ACTIONS, sec, "Label")
    IniWrite(gCtl["EditorMode"].Text, CFG_ACTIONS, sec, "Type")
    IniWrite(gCtl["EditorValue"].Text, CFG_ACTIONS, sec, "Value")
    IniWrite(gCtl["EditorNotes"].Text, CFG_ACTIONS, sec, "Notes")

    RefreshTiles()
    RefreshActionsTable()
    MaybeNotify("Сохранено: " profile " / " gSelectedLayer " / " gSelectedSlot)
}

ClearEditor() {
    global gCtl
    gCtl["EditorSlot"].Value := ""
    gCtl["EditorLabel"].Value := ""
    gCtl["EditorMode"].Text := "Disabled"
    gCtl["EditorValue"].Value := ""
    gCtl["EditorNotes"].Value := ""
    gCtl["PrettyValue"].Value := ""
    ResetShortcutControls()
}

TestCurrentEditorAction() {
    global gCtl
    act := Map(
        "Label", gCtl["EditorLabel"].Text,
        "Type", gCtl["EditorMode"].Text,
        "Value", gCtl["EditorValue"].Text,
        "Notes", gCtl["EditorNotes"].Text
    )
    ExecuteAction(act)
}

MakeTileCaptionV3(layer, slot) {
    global gCtl
    profile := gCtl.Has("ProfileDDL") ? gCtl["ProfileDDL"].Text : "Default"
    act := LoadAction(profile, layer, slot)

    type := act["Type"]
    label := act["Label"]
    if (label = "")
        label := "(empty)"
    if (type = "")
        type := "Disabled"

    marker := TypeMarker(type)
    prefix := (layer = "HS") ? "HS+" slot : slot
    return prefix "  " marker "`n" label "`n" TypeDisplay(type)
}

TypeMarker(type) {
    switch type {
        case "Shortcut": return "[S]"
        case "Text snippet": return "[T]"
        case "Sequence": return "[Q]"
        case "Launch": return "[L]"
        case "Menu": return "[M]"
        case "Disabled": return "[ ]"
        default: return "[?]"
    }
}

TypeDisplay(type) {
    return type
}

RefreshTiles() {
    global gCtl
    Loop 12 {
        gCtl["TILE_STD_" A_Index].Text := MakeTileCaptionV3("STD", A_Index)
        gCtl["TILE_HS_" A_Index].Text := MakeTileCaptionV3("HS", A_Index)
    }
}

RefreshActiveApp() {
    global gCtl
    hwnd := WinExist("A")
    exe := ""
    title := ""
    try exe := WinGetProcessName("ahk_id " hwnd)
    try title := WinGetTitle("ahk_id " hwnd)
    gCtl["ActiveApp"].Value := exe " -> " ResolveActiveProfile()
}

BeginWindowCapture(target := "Header") {
    global gPendingWinCapture, gCaptureTarget, gGui
    gPendingWinCapture := true
    gCaptureTarget := target
    ToolTip("Переключитесь на нужное окно. Захват через 2 секунды.")
    gGui.Minimize()
    SetTimer(CaptureWindowAfterDelay, -2000)
}

CaptureWindowAfterDelay() {
    global gPendingWinCapture, gCaptureTarget, gCtl, gGui
    ToolTip()
    hwnd := WinExist("A")
    exe := ""
    title := ""
    try exe := StrLower(WinGetProcessName("ahk_id " hwnd))
    try title := WinGetTitle("ahk_id " hwnd)

    gGui.Show()

    if (gCaptureTarget = "Mapping") {
        gCtl["MapExe"].Value := exe
        DebugLog("Captured mapping window => " exe " | " title)
    } else {
        gCtl["ActiveApp"].Value := exe " | " title
        DebugLog("Captured active window => " exe " | " title)
    }

    gPendingWinCapture := false
    gCaptureTarget := ""
}

BeginHotkeyRecord() {
    global gCaptureTarget
    gCaptureTarget := "RecordHotkey"
    ToolTip("Нажмите нужную комбинацию на клавиатуре или кнопку мыши")
}

SaveRecordedHotkey(hkName) {
    global gCtl, gCaptureTarget
    ToolTip()
    gCaptureTarget := ""

    meta := FindHotkeyMeta(hkName)
    if IsObject(meta) {
        ; это нажалась сама кнопка мыши Naga, ее в shortcut editor не надо класть
        MsgBox("Это сервисная кнопка Naga (" hkName "). Нажмите клавиатурную комбинацию.", APP_NAME)
        return
    }

    gCtl["EditorValue"].Value := hkName
    gCtl["PrettyValue"].Value := PrettyValue("Shortcut", hkName)
    LoadShortcutControls(hkName)
}

BuildShortcutFromControls() {
    global gCtl
    key := gCtl["SC_Key"].Text
    if (key = "") {
        MsgBox("Выберите основную клавишу", APP_NAME)
        return
    }

    ahk := ""
    if gCtl["SC_Ctrl"].Value
        ahk .= "^"
    if gCtl["SC_Shift"].Value
        ahk .= "+"
    if gCtl["SC_Alt"].Value
        ahk .= "!"
    if gCtl["SC_Win"].Value
        ahk .= "#"

    ahk .= KeyToAhk(key)

    gCtl["EditorValue"].Value := ahk
    gCtl["PrettyValue"].Value := PrettyValue("Shortcut", ahk)
}

LoadShortcutControls(ahkStr) {
    global gCtl
    ResetShortcutControls()
    if (ahkStr = "")
        return

    if InStr(ahkStr, "^")
        gCtl["SC_Ctrl"].Value := 1
    if InStr(ahkStr, "+")
        gCtl["SC_Shift"].Value := 1
    if InStr(ahkStr, "!")
        gCtl["SC_Alt"].Value := 1
    if InStr(ahkStr, "#")
        gCtl["SC_Win"].Value := 1

    key := ExtractMainKey(ahkStr)
    if (key != "")
        gCtl["SC_Key"].Text := key
}

ResetShortcutControls() {
    global gCtl
    gCtl["SC_Ctrl"].Value := 0
    gCtl["SC_Shift"].Value := 0
    gCtl["SC_Alt"].Value := 0
    gCtl["SC_Win"].Value := 0
    gCtl["SC_Key"].Text := ""
}

ExtractMainKey(ahkStr) {
    s := ahkStr
    s := StrReplace(s, "^")
    s := StrReplace(s, "+")
    s := StrReplace(s, "!")
    s := StrReplace(s, "#")
    if RegExMatch(s, "^\{(.+)\}$", &m)
        return m[1]
    return StrUpper(s)
}

BuildMainKeyList() {
    arr := []
    for ch in StrSplit("A,B,C,D,E,F,G,H,I,J,K,L,M,N,O,P,Q,R,S,T,U,V,W,X,Y,Z", ",")
        arr.Push(ch)
    for n in StrSplit("0,1,2,3,4,5,6,7,8,9", ",")
        arr.Push(n)
    for f in StrSplit("F1,F2,F3,F4,F5,F6,F7,F8,F9,F10,F11,F12", ",")
        arr.Push(f)
    for k in StrSplit("Enter,Tab,Space,Backspace,Delete,Insert,Home,End,PgUp,PgDn,Left,Right,Up,Down,Esc", ",")
        arr.Push(k)
    return arr
}

KeyToAhk(key) {
    special := Map(
        "ENTER", "{Enter}",
        "TAB", "{Tab}",
        "SPACE", "{Space}",
        "BACKSPACE", "{Backspace}",
        "DELETE", "{Delete}",
        "INSERT", "{Insert}",
        "HOME", "{Home}",
        "END", "{End}",
        "PGUP", "{PgUp}",
        "PGDN", "{PgDn}",
        "LEFT", "{Left}",
        "RIGHT", "{Right}",
        "UP", "{Up}",
        "DOWN", "{Down}",
        "ESC", "{Esc}"
    )

    u := StrUpper(key)
    if special.Has(u)
        return special[u]
    if RegExMatch(u, "^F\d+$")
        return "{" u "}"
    return StrLower(key)
}

PrettyValue(type, value) {
    if (value = "")
        return ""
    switch type {
        case "Shortcut":
            return AhkHotkeyToPretty(value)
        case "Text snippet":
            return "Текст: " Shorten(value, 36)
        case "Launch":
            return "Запуск: " Shorten(value, 36)
        case "Sequence":
            return "Последовательность"
        case "Menu":
            return "Меню: " value
        case "Disabled":
            return "Отключено"
        default:
            return value
    }
}

AhkHotkeyToPretty(ahk) {
    s := ahk
    out := []

    if InStr(s, "^")
        out.Push("Ctrl")
    if InStr(s, "+")
        out.Push("Shift")
    if InStr(s, "!")
        out.Push("Alt")
    if InStr(s, "#")
        out.Push("Win")

    key := ExtractMainKey(ahk)
    if (key != "") {
        keyPretty := key
        switch StrUpper(key) {
            case "PGUP": keyPretty := "PgUp"
            case "PGDN": keyPretty := "PgDn"
            case "ESC": keyPretty := "Esc"
            case "ENTER": keyPretty := "Enter"
            case "SPACE": keyPretty := "Space"
            case "BACKSPACE": keyPretty := "Backspace"
            case "DELETE": keyPretty := "Delete"
            case "LEFT": keyPretty := "Left"
            case "RIGHT": keyPretty := "Right"
            case "UP": keyPretty := "Up"
            case "DOWN": keyPretty := "Down"
        }
        out.Push(keyPretty)
    }

    pretty := ""
    for idx, item in out {
        if (idx > 1)
            pretty .= " + "
        pretty .= item
    }
    return pretty
}

Shorten(text, maxLen) {
    if (StrLen(text) <= maxLen)
        return text
    return SubStr(text, 1, maxLen - 1) "…"
}

AddMapping() {
    global gCtl, CFG_APPS
    exe := StrLower(Trim(gCtl["MapExe"].Text))
    profile := gCtl["MapProf"].Text

    if (exe = "" || profile = "") {
        MsgBox("Укажите exe и профиль", APP_NAME)
        return
    }

    IniWrite(profile, CFG_APPS, "Apps", exe)
    RefreshMappings()
}

DeleteSelectedMapping() {
    global gCtl, CFG_APPS
    row := gCtl["MappingsLV"].GetNext()
    if !row
        return
    exe := gCtl["MappingsLV"].GetText(row, 1)
    IniDelete(CFG_APPS, "Apps", exe)
    RefreshMappings()
}

RefreshMappings() {
    global gCtl, CFG_APPS
    lv := gCtl["MappingsLV"]
    lv.Delete()

    txt := IniRead(CFG_APPS, "Apps",, "")
    for line in StrSplit(txt, "`n", "`r") {
        if !InStr(line, "=")
            continue
        arr := StrSplit(line, "=",, 2)
        exe := Trim(arr[1])
        p := Trim(arr[2])
        if (exe != "")
            lv.Add(, exe, p)
    }
}

RefreshActionsTable() {
    global gCtl, gProfiles
    lv := gCtl["ActionsLV"]
    lv.Delete()

    for _, p in gProfiles {
        for _, layer in ["STD", "HS"] {
            Loop 12 {
                slot := A_Index
                act := LoadAction(p, layer, slot)
                if (act["Type"] != "")
                    lv.Add(, p, layer, slot, act["Label"], act["Type"], act["Value"], PrettyValue(act["Type"], act["Value"]))
            }
        }
    }
}

LoadSelectedAction() {
    global gCtl, gTab
    row := gCtl["ActionsLV"].GetNext()
    if !row
        return

    profile := gCtl["ActionsLV"].GetText(row, 1)
    layer := gCtl["ActionsLV"].GetText(row, 2)
    slot := Integer(gCtl["ActionsLV"].GetText(row, 3))

    gCtl["ProfileDDL"].Text := profile
    OnProfileChanged()
    gTab.Choose(1)
    OnTileClick(layer, slot)
}

FocusDebugTab() {
    global gTab
    gTab.Choose(4)
}

DebugLog(msg) {
    global gDebugLines, gCtl
    ts := FormatTime(, "yyyy-MM-dd HH:mm:ss")
    gDebugLines.Push("[" ts "] " msg)
    if (gDebugLines.Length > 700)
        gDebugLines.RemoveAt(1)

    txt := ""
    for _, line in gDebugLines
        txt .= line "`r`n"

    if gCtl.Has("DebugBox")
        gCtl["DebugBox"].Value := txt
}

ClearDebug() {
    global gDebugLines, gCtl
    gDebugLines := []
    gCtl["DebugBox"].Value := ""
}

LogActiveWindow() {
    hwnd := WinExist("A")
    exe := ""
    title := ""
    try exe := WinGetProcessName("ahk_id " hwnd)
    try title := WinGetTitle("ahk_id " hwnd)
    DebugLog("Window => EXE: " exe " | Title: " title " | Profile: " ResolveActiveProfile())
}

ShowCurrentProfile() {
    hwnd := WinExist("A")
    exe := ""
    try exe := WinGetProcessName("ahk_id " hwnd)
    MsgBox("EXE: " exe "`nProfile: " ResolveActiveProfile(), APP_NAME)
}

CreateNewProfile() {
    global gProfiles, gCtl
    ib := InputBox("Введите имя нового профиля", APP_NAME, "w320 h140")
    if (ib.Result != "OK")
        return
    name := Trim(ib.Value)
    if (name = "")
        return

    for _, p in gProfiles
        if (p = name)
            return

    gProfiles.Push(name)

    gCtl["ProfileDDL"].Delete()
    gCtl["ProfileDDL"].Add(gProfiles)
    gCtl["ProfileDDL"].Text := name

    gCtl["MapProf"].Delete()
    gCtl["MapProf"].Add(gProfiles)
    RefreshTiles()
}

MaybeNotify(text) {
    global CFG_SETTINGS
    if (IniRead(CFG_SETTINGS, "General", "ShowTrayNotifications", "1") = "1")
        TrayTip(text, APP_NAME, 1)
}

RefreshAll() {
    RefreshActiveApp()
    RefreshTiles()
    RefreshMappings()
    RefreshActionsTable()
    DebugLog("Studio initialized")
}

ShowMainGui() {
    global gGui
    RefreshAll()
    gGui.Show("w1440 h940")
}
