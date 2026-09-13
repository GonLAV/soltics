# אינסטגרם — Instagram Messaging API

## דרישות גישה (לבדוק לפני שימוש)

- חשבון אינסטגרם **עסקי/Creator**, מקושר לדף פייסבוק.
- Meta App מסוג Business, עם ה-Product "Instagram" מופעל.
- הרשאות: `instagram_basic` · `instagram_manage_messages` (DM) · `instagram_manage_comments` (תגובות) · `pages_show_list`.
- **הרשאות DM/תגובות דורשות App Review של מטא** (לא ניתנות אוטומטית לאפליקציה ב-Development Mode) — זה תהליך של ימים-שבועות, לא הרצת פקודה.

## Endpoints מרכזיים (v19+)

| פעולה | Endpoint |
|---|---|
| קריאת שיחות ממתינות | `GET /{ig-user-id}/conversations` |
| קריאת הודעות בשיחה | `GET /{conversation-id}?fields=messages` |
| שליחת DM | `POST /{ig-user-id}/messages` עם `recipient={id}` ו-`message={text}` |
| תגובה לתגובה | `POST /{comment-id}/replies` |

## מגבלות אמיתיות שצריך לדעת

- **חלון 24 שעות:** אפשר לשלוח הודעה חופשית ללקוח רק בתוך 24 שעות מההודעה האחרונה שלו. אחרי זה — רק "message tags" מוגבלים (לא לשיחת מכירה כללית). לבדוק את זה **לפני** שמנסחים תגובה למישהו שכתב לפני יומיים.
- **Rate limits** לפי App tier — לא לשלוח בכמות בלי לבדוק.
- טוקן שנוצר לדף פייסבוק לא בהכרח עובד ישירות ל-IG — צריך את ה-IG Business Account ID המקושר (`GET /{page-id}?fields=instagram_business_account`).

## אם אין הרשאה עדיין

לעבוד במצב ניסוח-בלבד: לקרוא את ההודעות (אם `instagram_basic` כן קיים) ולהציע תשובה שהמשתמש/ת ישלח/תשלח ידנית מהאפליקציה — לא לנסות לעקוף את החלון/ההרשאה בדרך אחרת.
