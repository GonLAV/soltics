# פייסבוק — Messenger Platform API

## דרישות גישה (לבדוק לפני שימוש)

- דף פייסבוק עסקי (Page) — לא פרופיל אישי.
- Meta App מסוג Business, Product "Messenger" מופעל, מחובר לדף.
- הרשאות: `pages_messaging` · `pages_show_list` · `pages_manage_metadata` (ל-webhooks).
- **`pages_messaging` דורשת App Review** אלא אם האפליקציה עדיין ב-Development Mode ומדברים רק עם אדמיני הדף — לא עם לקוחות אמיתיים.

## Endpoints מרכזיים

| פעולה | Endpoint |
|---|---|
| שליחת הודעה | `POST /me/messages` (עם Page Access Token) — `recipient={psid}`, `message={text}` |
| קריאת שיחות | דרך Webhook נכנס (`messages` event) — Messenger לא חושף "inbox" קריא ב-REST רגיל כמו IG, צריך להירשם ל-webhook כדי לקבל הודעות בזמן אמת |

## מגבלות אמיתיות

- **אותו חלון 24 שעות** כמו אינסטגרם (Messenger Platform Policy) — הודעה חופשית רק בתוך 24h מפנייה אחרונה של הלקוח.
- **דורש Webhook פעיל** כדי בכלל "לראות" הודעות נכנסות בזמן אמת — אי אפשר רק "לשלוף" תיבת הודעות בקריאת GET פשוטה. זו תשתית נוספת (endpoint ציבורי + HTTPS + אימות חתימה), לא רק טוקן.
- PSID (Page-Scoped ID) של כל לקוח שונה מה-ID שלו בפייסבוק הרגיל — לא אפשר "לשלוח לפי שם", רק לפי PSID שמגיע מהאירוע הנכנס.

## אם אין תשתית webhook עדיין

זה חסם אמיתי — אי אפשר "לנהל הודעות פייסבוק" בלי דרך לקבל אותן קודם. הצעד הראשון בפועל הוא להקים endpoint webhook (יכול לשבת באותו שרת VPS שכבר משמש את `finance-dashboard`/`bot/`), לא רק לבקש הרשאה.
