const express = require("express");
const app = express();
require("dotenv").config();

const line = require("@line/bot-sdk");
const OpenAI = require("openai");

// LINE Config
const config = {
  channelAccessToken: process.env.token,
  channelSecret: process.env.secretcode,
};

// OpenAI Client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_KEY,
});

app.post("/webhook", line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error("error handling events", err);
      res.status(500).send("error");
    });
});

const client = new line.Client(config);

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") {
    return null;
  }

  const userText = event.message.text.trim();
  const lowerText = userText.toLowerCase();

  if (!userText) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "พิมพ์ข้อความมาก่อนนะครับ 😊",
    });
  }

  if (userText.length > 500) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "ข้อความยาวเกินไปครับ ขอไม่เกิน 500 ตัวอักษร 🙏",
    });
  }

  if (lowerText.includes("สวัสดี") || lowerText.includes("hello")) {
    return client.replyMessage(event.replyToken, [
      { type: "text", text: "ยินดีที่ได้รู้จักครับ ผมชื่อ บอทไลน์ 😊" },
      { type: "text", text: "เป็นที่ปรึกษา และเพื่อนคุยของคุณครับ" },
      { type: "text", text: "คุณมีคำถามอะไรให้ผมช่วยไหมครับ?" },
    ]);
  }

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "คุณคือแชทบอทที่สุภาพ ตอบเป็นภาษาไทย" },
        { role: "user", content: userText },
      ],
    });

    return client.replyMessage(event.replyToken, {
      type: "text",
      text: completion.choices[0].message.content,
    });

  } catch (error) {
    console.error("AI Error:", error);
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "ขออภัยครับ ระบบ AI มีปัญหาชั่วคราว 😢",
    });
  }
}


// test route
app.get("/", (req, res) => {
  res.send("ok");
});

app.listen(8080, () => console.log("Server running on port 8080"));
