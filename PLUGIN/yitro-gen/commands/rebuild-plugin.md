---
description: "בנייה מחדש של הפלאגין (ייצור קובץ .plugin נייד)"
allowed-tools: Read, Write, Bash, Glob
---

# Rebuild Plugin

מטרה: לארוז את תיקיית הסוכן הנוכחית לקובץ `.plugin` יחיד שאפשר להתקין, לגבות או לשלוח.

> הערה לסביבה: העבודה עשויה להתבצע ב-Windows, והריצה בסביבת Linux שבה ה-repo מחובר.
> הקובץ הסופי נשמר בתוך ה-repo המחובר (`plugin-builds/`)
> כדי שהמשתמש/ת יוכל/תוכל לראות אותו ולגשת אליו ישירות.

## שלב 1 — אימות

1. ודא שאתה נמצא בתוך תיקיית סוכן: חייב להיות `.claude-plugin/plugin.json`.
2. שלוף את שם הסוכן מתוך השדה `name` שב-`plugin.json` (זה יהיה שם הקובץ).
3. בדוק שהקבצים המרכזיים קיימים:
   - `.claude-plugin/plugin.json` (חובה)
   - `system-prompt.md`
   - `skills/yitro-gen/SKILL.md` + `references/`
   - `commands/`

## שלב 2 — בנייה (zip)

מתוך תיקיית הסוכן, ארוז את כל התוכן לקובץ זמני:

```bash
cd <agent-folder>
zip -r "/tmp/yitro-gen.plugin" . -x "*.DS_Store"
```

## שלב 3 — שמירה במקום נגיש (בתוך ה-repo המחובר)

צור תיקיית פלט בשורש ה-repo אם אינה קיימת, והעתק לשם:

```bash
mkdir -p <repo-root>/plugin-builds
cp "/tmp/yitro-gen.plugin" "<repo-root>/plugin-builds/yitro-gen.plugin"
```

`<repo-root>` = שורש הריפו המחובר.
כך הקובץ נשמר בתיקייה שהמשתמש/ת רואה.

## שלב 4 — דיווח

הצג למשתמש/ת:
- נתיב הקובץ שנוצר (בתוך `plugin-builds/`)
- גודל הקובץ
- רשימת הקבצים/התיקיות שנכללו בו

## איך מתקינים את הקובץ (להזכיר למשתמש/ת)

- **גרירה:** גוררים את קובץ ה-`.plugin` לתוך חלון Claude Desktop.
- **אם הגרירה לא עובדת (Windows):** מחלצים את ה-zip לתיקיית הפלאגינים של Claude,
  סוגרים את Claude Desktop לגמרי ופותחים מחדש.
  (אם צריך את הנתיב המדויק ב-Windows — לברר יחד, לא לנחש.)
