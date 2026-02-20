require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { google } = require("googleapis");

const app = express();
app.use(express.json({ limit: "15mb" }));

const PORT = process.env.PORT || 3000;

// ===== ENV =====
const SHEET_ID = process.env.SHEET_ID;

// Green API
const GREEN_API_ID = process.env.GREEN_API_ID; // waInstanceXXXX
const GREEN_API_TOKEN = process.env.GREEN_API_TOKEN;

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
    (payload.messageData?.textMessageData ? "text" : "unknown")
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

// ===== Google Auth (Base64 supported) =====
function getGoogleAuthFromEnv() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON env var");

  let creds;
  try {
    // maybe plain JSON
    creds = JSON.parse(raw);
  } catch {
    // assume base64
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

/**
 * Find lead row by phone in leads sheet.
 * returns { rowIndex (1-based), rowValues } or null
 */
async function findLeadByPhone(phone) {
  const auth = getGoogleAuthFromEnv();
  const sheets = getSheetsClient(auth);

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "leads!A:F", // phone..last_message
  });

  const rows = res.data.values || [];
  if (rows.length <= 1) return null; // header only

  // rows[0] header
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const rowPhone = row?.[0] || "";
    if (String(rowPhone) === String(phone)) {
      // sheet row index is i+1 (because header row is 1)
      return { rowIndex: i + 1, rowValues: row };
    }
  }
  return null;
}

/**
 * Update or create lead row.
 * leads columns: phone | name | status | created_at | updated_at | last_message
 */
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
  // Update updated_at (E) and last_message (F)
  const updateRange = `leads!E${rowIndex}:F${rowIndex}`;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: updateRange,
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
  const payload = {
    chatId,
    message: text,
  };

  const res = await axios.post(url, payload, { timeout: 15000 });
  return res.data;
}

// ===== Routes =====
app.get("/", (req, res) => {
  res.status(200).send("WA Bot Server is running");
});

app.post("/webhook", async (req, res) => {
  // 1) respond fast to prevent retries
  res.sendStatus(200);

  // 2) process async
  try {
    const payload = req.body || {};
    const ts = nowIso();

    const chatId = extractChatId(payload);
    const phone = extractPhoneFromChatId(chatId);
    const msgType = extractMsgType(payload);
    const text = extractText(payload);

    // לוג נכנס
    const incomingRow = [
      ts, // timestamp
      phone, // phone
      chatId, // chat_id
      "incoming", // direction
      msgType, // msg_type
      safeStr(text || payload, 2000), // message
      "", // intent
      "", // ai_model
      "", // tokens_in
      "", // tokens_out
    ];
    await appendRow("conversation_logs!A:J", incomingRow);

    // עדכון leads
    if (phone) {
      await upsertLead({ phone, lastMessage: text || `[${msgType}]` });
    }

    // === Reply בסיסי כדי לוודא שהשליחה עובדת (בשלב הבא נחליף ל-AI) ===
    if (chatId && msgType === "text" && text) {
      const reply = `קיבלתי ✅\nכתבת: "${text}"\n\nרק רגע, אני בודק ומחזיר תשובה.`;
      await sendWhatsAppMessage(chatId, reply);

      // לוג יוצא
      const outgoingRow = [
        nowIso(),
        phone,
        chatId,
        "outgoing",
        "text",
        safeStr(reply, 2000),
        "",
        "",
        "",
        "",
      ];
      await appendRow("conversation_logs!A:J", outgoingRow);
    }
  } catch (err) {
    console.error("Webhook processing error:", err?.response?.data || err);

    // אפשר גם לכתוב לוג שגיאה ל-sheet אם תרצה (אופציונלי)
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
