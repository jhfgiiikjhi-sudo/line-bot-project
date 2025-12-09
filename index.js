const express = require("express");
const app = express();
require("dotenv").config();

const line = require("@line/bot-sdk");
const OpenAI = require("openai");

// เก็บ userId ที่เคยได้รับคำทักทายแล้ว
const greetedUsers = new Set();

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
    return Promise.resolve(null);
  }

  const userId = event.source.userId;

  // =============== ส่งข้อความทักทายครั้งแรก ===============
  if (!greetedUsers.has(userId)) {
    greetedUsers.add(userId);

    return client.replyMessage(event.replyToken, [
      { type: "text", text: "ยินดีที่ได้รู้จักครับ ผมชื่อ บอทไลน์" },
      { type: "text", text: "เป็นที่ปรึกษา และเพื่อนคุยของคุณครับ" },
      { type: "text", text: "คุณมีคำถาม หรือให้ผมช่วยอะไรไหมครับ?" },
    ]);
  }

  // =============== AI ตอบกลับข้อความ ===============
  try {
    const userText = event.message.text;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "คุณคือแชทบอทที่สุภาพและตอบเป็นภาษาไทย" },
        { role: "user", content: userText },
      ],
    });

    const aiReply = completion.choices[0].message.content;

    return client.replyMessage(event.replyToken, {
      type: "text",
      text: aiReply,
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
