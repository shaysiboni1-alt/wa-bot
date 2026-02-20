require("dotenv").config();
const express = require("express");
const { google } = require("googleapis");

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3000;
const SHEET_ID = process.env.SHEET_ID;

// Google Auth דרך ENV (JSON מלא)
function getGoogleAuthFromEnv() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON env var");
  const creds = JSON.parse(raw);

  return new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

async function appendLogRow(row) {
  const auth = getGoogleAuthFromEnv();
  const sheets = google.sheets({ version: "v4", auth });

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: "conversation_logs!A:J",
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });
}

app.get("/", (req, res) => {
  res.status(200).send("WA Bot Server is running");
});

// Webhook endpoint
app.post("/webhook", async (req, res) => {
  // חשוב: להחזיר 200 מהר כדי למנוע retries
  res.sendStatus(200);

  try {
    const payload = req.body || {};
    const now = new Date().toISOString();

    // ניסוי חילוץ טלפון/צ׳אט (תלוי בפורמט של Green API)
    const chatId =
      payload.chatId ||
      payload.senderData?.chatId ||
      payload.messageData?.chatId ||
      payload.senderData?.sender ||
      "";

    const phone = chatId ? String(chatId).split("@")[0] : "";

    const msgText =
      payload.message ||
      payload.textMessage ||
      payload.messageData?.textMessageData?.textMessage ||
      payload.messageData?.extendedTextMessageData?.text ||
      JSON.stringify(payload).slice(0, 500);

    const msgType =
      payload.typeMessage ||
      payload.messageData?.typeMessage ||
      (payload.messageData?.textMessageData ? "text" : "unknown");

    // direction: incoming תמיד ב-webhook
    const row = [
      now, // timestamp
      phone, // phone
      chatId, // chat_id
      "incoming", // direction
      msgType, // msg_type
      String(msgText).slice(0, 2000), // message
      "", // intent (נמלא בשלב AI)
      "", // ai_model
      "", // tokens_in
      "", // tokens_out
    ];

    await appendLogRow(row);
  } catch (err) {
    console.error("Webhook log error:", err?.response?.data || err);
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
