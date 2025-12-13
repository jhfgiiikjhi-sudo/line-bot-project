const express = require("express");
const app = express();
require("dotenv").config();

const line = require("@line/bot-sdk");
const OpenAI = require("openai");
const moment = require("moment-timezone");
require("moment/locale/th");

// ================= LINE CONFIG =================
const config = {
  channelAccessToken: process.env.token,
  channelSecret: process.env.secretcode,
};

const client = new line.Client(config);

// ================= OpenAI =================
const openai = new OpenAI({
  apiKey: process.env.OPENAI_KEY,
});

// ================= WEBHOOK =================
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    const results = await Promise.all(req.body.events.map(handleEvent));
    res.json(results);
  } catch (err) {
    console.error("Webhook Error:", err);
    res.status(500).end();
  }
});

// ================= MAIN LOGIC =================
async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") {
    return null;
  }

  const userText = event.message.text.trim();
  const lowerText = userText.toLowerCase();

  if (!userText) {
    return reply(event, "พิมพ์ข้อความมาก่อนนะครับ 😊");
  }

  if (userText.length > 500) {
    return reply(event, "ข้อความยาวเกินไปครับ ขอไม่เกิน 500 ตัวอักษร 🙏");
  }

  // ---------- TIME / DATE (ไม่ใช้ AI) ----------
  const now = moment().tz("Asia/Bangkok").locale("th");

  const buddhistYear2Digit = (now.year() + 543) % 100;

  if (lowerText.includes("กี่โมง") || lowerText.includes("เวลา")) {
    return reply(event, `⏰ ตอนนี้เวลา ${now.format("HH:mm")} น. ครับ`);
  }

  if (lowerText.includes("วันนี้")) {
    return reply(
      event,
      `📅 วันนี้คือวัน${now.format("dddd ที่ D MMMM")} ${buddhistYear2Digit}`
    );
  }

  if (lowerText.includes("พรุ่งนี้")) {
    const tomorrow = now.clone().add(1, "day");
    const tomorrowYear = (tomorrow.year() + 543) % 100;

    return reply(
      event,
      `📅 พรุ่งนี้คือวัน${tomorrow.format("dddd ที่ D MMMM")} ${tomorrowYear}`
    );
  }

  // ---------- GREETING ----------
  if (lowerText.includes("สวัสดี") || lowerText.includes("hello")) {
    return client.replyMessage(event.replyToken, [
      { type: "text", text: "ยินดีที่ได้รู้จักครับ ผมชื่อ บอทไลน์ 😊" },
      { type: "text", text: "เป็นที่ปรึกษา และเพื่อนคุยของคุณครับ" },
      { type: "text", text: "คุณมีคำถามอะไรให้ผมช่วยไหมครับ?" },
    ]);
  }

  // ---------- AI RESPONSE ----------
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "คุณคือแชทบอทที่สุภาพ เป็นกันเอง และตอบเป็นภาษาไทยอย่างเข้าใจง่าย",
        },
        { role: "user", content: userText },
      ],
      max_tokens: 300,
    });

    const aiReply = completion.choices[0].message.content;
    return reply(event, aiReply);

  } catch (error) {
    console.error("AI Error:", error);
    return reply(event, "ขออภัยครับ ระบบ AI มีปัญหาชั่วคราว 😢");
  }
}

// ================= HELPER =================
function reply(event, text) {
  return client.replyMessage(event.replyToken, {
    type: "text",
    text,
  });
}

// ================= TEST =================
app.get("/", (req, res) => {
  res.send("ok");
});

app.listen(8080, () =>
  console.log("🚀 Server running on port 8080")
);
