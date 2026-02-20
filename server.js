require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { google } = require("googleapis");

const app = express();
app.use(express.json({ limit: "15mb" }));

const PORT = process.env.PORT || 3000;

// ===== ENV =====
const SHEET_ID = process.env.SHEET_ID;
const GREEN_API_ID = process.env.GREEN_API_ID;     // מספר בלבד
const GREEN_API_TOKEN = process.env.GREEN_API_TOKEN;

// ===== In-memory de-dup cache =====
// מונע עיבוד כפול (retries/duplicates) וגם עוזר לעצור לולאות.
const seen = new Map(); // key -> timestamp(ms)
const SEEN_TTL_MS = 2 * 60 * 1000; // 2 דקות

function cleanupSeen() {
  const now = Date.now();
  for (const [k, t] of seen.entries()) {
    if (now - t > SEEN_TTL_MS) seen.delete(k);
  }
}
setInterval(cleanupSeen, 30 * 1000).unref();

// ===== Helpers =====
function nowIso() {
  return new Date().toISOString();
}

function safeStr(v, max = 2000) {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > max ? s.slice(0, max) : s;
}

function extractChatId(payload) {
  return (
    payload.chatId ||
    payload.senderData?.chatId ||
    payload.messageData?.chatId ||
    payload.senderData?.sender ||
    ""
  );
}

function extractPhoneFromChatId(chatId) {
  if (!chatId) return "";
  return String(chatId).split("@")[0];
}

function extractMsgType(payload) {
  return (
    payload.typeMessage ||
    payload.messageData?.typeMessage ||
    (payload.messageData?.textMessageData ? "textMessage" : "unknown")
  );
}

function extractText(payload) {
  return (
    payload.message ||
    payload.textMessage ||
    payload.messageData?.textMessageData?.textMessage ||
    payload.messageData?.extendedTextMessageData?.text ||
    payload.messageData?.quotedMessage?.textMessage ||
    ""
  );
}

/**
 * מזהה האם זו הודעה שנשלחה ע"י החשבון שלנו (כלומר outgoing echo).
 * Green API בדר"כ מספק fromMe / senderData.sender / chatId וכו'. השדות משתנים בין סוגי notifications.
 * נשתמש בכמה בדיקות "סלחניות".
 */
function isFromMe(payload) {
  // דגלים נפוצים:
  if (payload.fromMe === true) return true;
  if (payload.senderData?.fromMe === true) return true;
  if (payload.messageData?.fromMe === true) return true;

  // חלק מהאירועים כוללים sender = chatId של הבוט עצמו או "me"
  const sender = payload.senderData?.sender || payload.messageData?.sender || "";
  if (sender && (String(sender).includes("@c.us") || String(sender).includes("@g.us"))) {
    // אם sender == chatId, לעיתים זה אומר "הצד השני", אבל לא תמיד.
    // לא מסתמכים על זה לבד.
  }

  // דרך מעשית: אם הטקסט מתחיל בדיוק במה שהבוט שולח (קיבלתי ✅) סביר שזה echo
  const text = extractText(payload);
  if (text && text.startsWith("קיבלתי ✅")) return true;

  // אם Green API שולח סוג notification "outgoing" (תלוי הגדרה)
  const typeWebhook = payload.typeWebhook || payload.eventType || "";
  if (String(typeWebhook).toLowerCase().includes("outgoing")) return true;

  return false;
}

/**
 * יוצר מפתח ייחודי להודעה כדי למנוע דופליקציה.
 */
function makeDedupKey(payload) {
  const chatId = extractChatId(payload);
  const msgId =
    payload.idMessage ||
    payload.messageData?.idMessage ||
    payload.messageData?.extendedTextMessageData?.contextInfo?.stanzaId ||
    "";
  const text = extractText(payload);
  const type = payload.typeWebhook || payload.eventType || payload.typeMessage || payload.messageData?.typeMessage || "";
  return `${chatId}|${msgId}|${type}|${text}`.slice(0, 500);
}

// ===== Google Auth (Base64 supported) =====
function getGoogleAuthFromEnv() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON env var");

  let creds;
  try {
    creds = JSON.parse(raw);
  } catch {
    const decoded = Buffer.from(raw, "base64").toString("utf-8");
    creds = JSON.parse(decoded);
  }

  return new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

function getSheetsClient(auth) {
  return google.sheets({ version: "v4", auth });
}

async function appendRow(rangeA1, valuesRow) {
  const auth = getGoogleAuthFromEnv();
  const sheets = getSheetsClient(auth);

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: rangeA1,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [valuesRow] },
  });
}

async function findLeadByPhone(phone) {
  const auth = getGoogleAuthFromEnv();
  const sheets = getSheetsClient(auth);

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "leads!A:F",
  });

  const rows = res.data.values || [];
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i]?.[0] || "") === String(phone)) {
      return { rowIndex: i + 1, rowValues: rows[i] };
    }
  }
  return null;
}

async function upsertLead({ phone, lastMessage }) {
  const auth = getGoogleAuthFromEnv();
  const sheets = getSheetsClient(auth);

  const existing = await findLeadByPhone(phone);
  const ts = nowIso();

  if (!existing) {
    const newRow = [phone, "", "new", ts, ts, safeStr(lastMessage, 500)];
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "leads!A:F",
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [newRow] },
    });
    return { action: "inserted" };
  }

  const rowIndex = existing.rowIndex;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `leads!E${rowIndex}:F${rowIndex}`,
    valueInputOption: "RAW",
    requestBody: { values: [[ts, safeStr(lastMessage, 500)]] },
  });

  return { action: "updated", rowIndex };
}

// ===== WhatsApp send via Green API =====
async function sendWhatsAppMessage(chatId, text) {
  if (!GREEN_API_ID || !GREEN_API_TOKEN) {
    throw new Error("Missing GREEN_API_ID or GREEN_API_TOKEN in env");
  }

  const url = `https://api.green-api.com/waInstance${GREEN_API_ID}/sendMessage/${GREEN_API_TOKEN}`;
  const payload = { chatId, message: text };

  const res = await axios.post(url, payload, { timeout: 15000 });
  return res.data;
}

// ===== Routes =====
app.get("/", (req, res) => res.status(200).send("WA Bot Server is running"));

app.post("/webhook", async (req, res) => {
  // חשוב: 200 מיד
  res.sendStatus(200);

  const payload = req.body || {};

  // 1) דה-דופ
  const dedupKey = makeDedupKey(payload);
  if (seen.has(dedupKey)) {
    return; // כבר טופל
  }
  seen.set(dedupKey, Date.now());

  // 2) לא להגיב להודעות שלנו
  if (isFromMe(payload)) {
    // עדיין אפשר לשמור לוג אם תרצה, אבל כרגע נמנע כתיבות כדי לא להגיע ל-429
    console.log("[SKIP fromMe/echo]");
    return;
  }

  try {
    const ts = nowIso();
    const chatId = extractChatId(payload);
    const phone = extractPhoneFromChatId(chatId);
    const msgType = extractMsgType(payload);
    const text = extractText(payload);

    console.log(`[IN] chatId=${chatId} phone=${phone} type=${msgType} text=${safeStr(text, 200)}`);

    // לוג רק על נכנס (מונע עומס כתיבה)
    await appendRow("conversation_logs!A:J", [
      ts,
      phone,
      chatId,
      "incoming",
      msgType,
      safeStr(text || payload, 2000),
      "",
      "",
      "",
      "",
    ]);

    if (phone) {
      await upsertLead({ phone, lastMessage: text || `[${msgType}]` });
    }

    const isText = String(msgType).toLowerCase().includes("text");
    if (chatId && isText && text) {
      const reply = `קיבלתי ✅\nכתבת: "${text}"\n\nאיך אפשר לעזור?`;

      const sendRes = await sendWhatsAppMessage(chatId, reply);
      console.log("[SEND OK]", sendRes);

      // בכוונה לא כותבים outgoing ל-Sheets בשלב זה כדי למנוע 429.
      // אם תרצה, נוסיף batching/queue בשלב הבא.
    }
  } catch (err) {
    console.error("Webhook processing error:", err?.response?.data || err);
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
