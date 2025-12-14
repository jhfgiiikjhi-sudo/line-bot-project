const express = require("express");
const app = express();
require("dotenv").config();

const fs = require("fs");
const line = require("@line/bot-sdk");
const OpenAI = require("openai");
const moment = require("moment-timezone");
require("moment/locale/th");

// ================= USER MEMORY =================
const USERS_FILE = "./users.json";
let users = {};

// โหลดข้อมูลผู้ใช้
if (fs.existsSync(USERS_FILE)) {
  try {
    users = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  } catch (err) {
    console.error("Error reading users.json:", err);
    users = {};
  }
}

// บันทึกข้อมูลผู้ใช้
function saveUsers() {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

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

  const userId = event.source.userId;
  const userText = event.message.text.trim();
  const lowerText = userText.toLowerCase();

  // ---------- CREATE USER ----------
  if (!users[userId]) {
    users[userId] = {
      step: "ask_name",
      createdAt: new Date().toISOString(),
    };
    saveUsers();

    return reply(
      event,
      "สวัสดีครับ 😊\nก่อนคุยกัน ผมขอรู้จักคุณนิดนึงนะครับ\n\nคุณชื่ออะไรครับ?"
    );
  }

  const user = users[userId];

  // ---------- STEP: ASK NAME ----------
  if (user.step === "ask_name") {
    user.name = userText;
    user.step = "ask_age";
    saveUsers();

    return reply(
      event,
      `ยินดีที่ได้รู้จักครับ ${user.name} 😊\nคุณอายุเท่าไหร่ครับ?`
    );
  }

  // ---------- STEP: ASK AGE ----------
  if (user.step === "ask_age") {
    const age = parseInt(userText);

    if (isNaN(age) || age <= 0 || age > 120) {
      return reply(event, "กรุณาพิมพ์อายุเป็นตัวเลขที่ถูกต้องนะครับ 😊");
    }

    user.age = age;
    user.step = "ask_birthday";
    saveUsers();

    return reply(
      event,
      "วันเกิดของคุณวันที่เท่าไหร่หรอครับ?\n(ตัวอย่าง: 20/11/2548)"
    );
  }

  // ---------- STEP: ASK BIRTHDAY ----------
  if (user.step === "ask_birthday") {
    const birthdayRegex = /^\d{2}\/\d{2}\/\d{4}$/;

    if (!birthdayRegex.test(userText)) {
      return reply(
        event,
        "รูปแบบวันเกิดไม่ถูกต้องนะครับ 😊\nกรุณาพิมพ์แบบนี้: 20/11/2548"
      );
    }

    user.birthday = userText;
    user.step = "done";
    saveUsers();

    return reply(
      event,
      `ขอบคุณครับ 🙏\nสรุปข้อมูลของคุณคือ\n\n👤 ชื่อ: ${user.name}\n🎂 อายุ: ${user.age}\n📅 วันเกิด: ${user.birthday}\n\nต่อไปผมจะจำคุณได้แล้วครับ 😊`
    );
  }

  // ================= COMMANDS (ไม่ใช้ AI) =================
  const now = moment().tz("Asia/Bangkok").locale("th");
  const buddhistYear = (now.year() + 543).toString().slice(-2);

  if (lowerText.includes("กี่โมง") || lowerText.includes("เวลา")) {
    return reply(event, `⏰ ตอนนี้เวลา ${now.format("HH:mm")} น. ครับ`);
  }

  if (lowerText.includes("วันนี้")) {
    return reply(
      event,
      `📅 วันนี้คือวัน${now.format("dddd ที่ D MMMM")} ${buddhistYear}`
    );
  }

  if (lowerText.includes("ข้อมูลของฉัน")) {
    return reply(
      event,
      `📌 ข้อมูลของคุณ\n\n👤 ชื่อ: ${user.name}\n🎂 อายุ: ${user.age}\n📅 วันเกิด: ${user.birthday}`
    );
  }

  // ================= AI RESPONSE =================
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `คุณคือแชทบอทที่สุภาพ เป็นกันเอง ตอบเป็นภาษาไทย และกำลังคุยกับผู้ใช้ชื่อ ${user.name}`,
        },
        { role: "user", content: userText },
      ],
      max_tokens: 300,
    });

    return reply(event, completion.choices[0].message.content);

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

app.listen(8080, () => {
  console.log("🚀 Server running on port 8080");
});
