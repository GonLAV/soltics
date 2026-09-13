---
description: "בנייה מחדש של הפלאגין (ייצור קובץ .plugin נייד)"
allowed-tools: Read, Write, Bash, Glob
---

# Rebuild Plugin

מטרה: לארוז את תיקיית הסוכן הנוכחית לקובץ `.plugin` יחיד שאפשר להתקין, לגבות או לשלוח.

> הקובץ הסופי נשמר בתוך הריפו המחובר (`plugin-builds/`) כדי שיהיה נגיש ישירות.

## שלב 1 — אימות

1. ודא שאתה נמצא בתוך תיקיית סוכן: חייב להיות `.claude-plugin/plugin.json`.
2. שלוף את שם הסוכן מתוך השדה `name` שב-`plugin.json` (זה יהיה שם הקובץ).
3. בדוק שהקבצים המרכזיים קיימים:
   - `.claude-plugin/plugin.json` (חובה)
   - `skills/` (חובה)
   - `commands/` (אם קיים)

## שלב 2 — בנייה (zip)

מתוך תיקיית הסוכן, ארוז את כל התוכן לקובץ זמני:

```bash
cd <agent-folder>
zip -r "/tmp/<agent-name>.plugin" . -x "*.DS_Store"
```

> ⚠️ **ב-Windows** (Git Bash) `zip` לא קיים ו-`Compress-Archive` יוצר נתיבים עם `\` ששוברים
> התקנה ב-Mac. באריזה מ-Windows השתמש ב-`System.IO.Compression` עם החלפת `\`→`/`.

## שלב 3 — שמירה במקום נגיש (בתוך הריפו המחובר)

```bash
mkdir -p <repo-root>/plugin-builds
cp "/tmp/<agent-name>.plugin" "<repo-root>/plugin-builds/<agent-name>.plugin"
```

`<repo-root>` = שורש הריפו המחובר.

## שלב 4 — דיווח

הצג:
- נתיב הקובץ שנוצר (בתוך `plugin-builds/`)
- גודל הקובץ
- רשימת הקבצים/התיקיות שנכללו בו

## איך מתקינים את הקובץ

- **גרירה:** גוררים את קובץ ה-`.plugin` לתוך חלון Claude Desktop.
- **אם הגרירה לא עובדת (Windows):** מחלצים את ה-zip לתיקיית הפלאגינים של Claude,
  סוגרים את Claude Desktop לגמרי ופותחים מחדש.
