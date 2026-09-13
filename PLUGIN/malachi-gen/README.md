# מלאכי — מנהל ההודעות של QUAD

סוכן-שותף שמנהל את השיחות הנכנסות (DM, תגובות) באינסטגרם ופייסבוק Messenger עבור QUAD Clinic — מנסח תגובה, מציג בדיוק מה יישלח, ושולח רק אחרי אישור מפורש לכל הודעה בנפרד. טיקטוק: בדיקת היתכנות בלבד, לא בנוי.

**מגבלת-ברזל:** לעולם לא שולח/מפרסם בלי אישור מפורש ברגע השליחה — אין מצב "אישרת פעם, תמשיך לבד".

## הפעלה

```
/malachi
```

## מצב הגישה נכון להקמה (31/08/2026)

לא ידוע אם יש הרשאות `pages_messaging` / `instagram_manage_messages` על אפליקציית ה-Meta הקיימת של QUAD (LAEL CLAUDE) — **שלב 0 של הסוכן הוא תמיד לבדוק את זה קודם**, לא להניח. אם אין — עובד במצב ניסוח-בלבד עד שהגישה תוקם (כרוך ב-App Review של מטא, לא מיידי).

טיקטוק: אין היום גישת API DM לעסקים קטנים/בינוניים; פרסום תוכן דורש אישור-שותף מ-TikTok שיכול לקחת שבועות. ראה `skills/malachi-gen/references/tiktok-status.md`.

## מבנה

```
malachi-gen/
├── .claude-plugin/plugin.json
├── system-prompt.md
├── commands/
│   ├── malachi.md
│   └── rebuild-plugin.md
└── skills/malachi-gen/
    ├── SKILL.md
    └── references/
        ├── comms-workflow.md        ← לולאת ניסוח→הצגה→אישור→שליחה + בדיקת הרשאות
        ├── instagram.md             ← Instagram Messaging API
        ├── facebook-messenger.md    ← Messenger Platform API
        └── tiktok-status.md         ← מצב בדיקת היתכנות
```
