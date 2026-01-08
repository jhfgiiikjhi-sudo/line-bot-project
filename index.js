const express = require("express");
const app = express();
require("dotenv").config();

const fs = require("fs");
const line = require("@line/bot-sdk");
const OpenAI = require("openai");
const moment = require("moment-timezone");
require("moment/locale/th");
const officialFacts = require("./officialFacts");

// ================= USER MEMORY =================
const USERS_FILE = "./users.json";
let users = {};

if (fs.existsSync(USERS_FILE)) {
  try {
    users = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  } catch {
    users = {};
  }
}

function saveUsers() {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// ================= LINE CONFIG =================
const client = new line.Client({
  channelAccessToken: process.env.token,
  channelSecret: process.env.secretcode,
});

// ================= OpenAI =================
const openai = new OpenAI({
  apiKey: process.env.OPENAI_KEY,
});

// ================= CONSTANTS =================
const FORBIDDEN_NAMES = [
  "ไม่บอก",
  "ไม่รู้",
  "ไม่",
  "none",
  "no",
  "skip",
  "ข้าม",
  "test",
  "xxx",
];

// ================= WEBHOOK =================
app.post("/webhook", line.middleware(client.config), async (req, res) => {
  await Promise.all(req.body.events.map(handleEvent));
  res.json({ status: "ok" });
});

// ================= MAIN LOGIC =================
async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") {
    return null;
  }

  const userId = event.source?.userId;
  if (!userId) return reply(event, "เกิดข้อผิดพลาด กรุณาลองใหม่ครับ");

  const userText = event.message.text.trim();
  const lowerText = userText.toLowerCase();

  if (!userText) return reply(event, "กรุณาพิมพ์ข้อความก่อนนะครับ");

  // ===== CREATE USER =====
  if (!users[userId]) {
    users[userId] = { step: "intro" };
    saveUsers();
    return reply(event, "สวัสดีครับ 😊\nก่อนเริ่มใช้งาน ขอทราบชื่อคุณหน่อยครับ");
  }

  const user = users[userId];

  // ================= ASK NAME (STRICT) =================
  if (user.step === "intro") {
    const name = userText.replace(/\s+/g, "");

    if (
      FORBIDDEN_NAMES.includes(name.toLowerCase()) ||
      /^\d+$/.test(name) ||
      /[^a-zA-Zก-๙]/.test(name) ||
      name.length < 2 ||
      name.length > 20
    ) {
      return reply(
        event,
        "❌ กรุณาพิมพ์ชื่อจริง\nใช้ตัวอักษรเท่านั้น (2–20 ตัว)\nตัวอย่าง: สมชาย / Ohm"
      );
    }

    user.name = name;
    user.step = "ask_age";
    saveUsers();

    return reply(event, `ยินดีที่ได้รู้จักครับ ${user.name} 😊\nคุณอายุเท่าไหร่ครับ?`);
  }

  // ================= ASK AGE =================
  if (user.step === "ask_age") {
    const age = Number(userText);

    if (!Number.isInteger(age) || age < 1 || age > 60) {
      return reply(event, "❌ กรุณาพิมพ์อายุเป็นตัวเลข 1–60 เท่านั้น");
    }

    user.age = age;
    user.step = "ask_birthday";
    saveUsers();

    return reply(
      event,
      "วันเกิดของคุณวันไหนครับ?\nตัวอย่าง: 20/11/2548\nหรือพิมพ์ \"ข้าม\""
    );
  }

  // ================= ASK BIRTHDAY =================
  if (user.step === "ask_birthday") {
    if (["ข้าม", "ไม่บอก", "skip"].includes(lowerText)) {
      user.birthday = null;
      user.step = "done";
      saveUsers();

      return reply(
        event,
        `ขอบคุณครับ 🙏\n👤 ${user.name}\n🎂 อายุ ${user.age} ปี`
      );
    }

    if (!moment(userText, "DD/MM/YYYY", true).isValid()) {
      return reply(event, "❌ รูปแบบวันเกิดไม่ถูกต้อง\nหรือพิมพ์ \"ข้าม\"");
    }

    user.birthday = userText;
    user.step = "done";
    saveUsers();

    return reply(
      event,
      `บันทึกข้อมูลเรียบร้อยครับ 😊\n👤 ${user.name}\n🎂 ${user.age} ปี\n📅 ${user.birthday}`
    );
  }

  // ================= TIME =================
  const now = moment().tz("Asia/Bangkok").locale("th");

  if (lowerText.includes("กี่โมง") || lowerText.includes("เวลา")) {
    return reply(event, `⏰ ตอนนี้ ${now.format("HH:mm")} น.`);
  }

  if (lowerText.includes("วันนี้")) {
    return reply(event, `📅 วันนี้คือวัน${now.format("dddd ที่ D MMMM YYYY")}`);
  }

  // ================= BIRTHDAY COUNTDOWN =================
  if (lowerText.includes("วันเกิด")) {
    if (!user.birthday) {
      return reply(event, "คุณยังไม่ได้บอกวันเกิดไว้ครับ");
    }

    const [d, m] = user.birthday.split("/");
    let bday = moment.tz(`${now.year()}-${m}-${d}`, "Asia/Bangkok");
    if (bday.isBefore(now, "day")) bday.add(1, "year");

    const diff = bday.diff(now, "days");
    return reply(event, `🎂 เหลืออีก ${diff} วัน จะถึงวันเกิดคุณครับ`);
  }

  // ================= FUTURE BLOCK =================
  if (
    lowerText.includes("นายก") &&
    (lowerText.includes("ต่อไป") || lowerText.includes("อนาคต"))
  ) {
    return reply(
      event,
      "ขออภัยครับ 🙏 เรื่องในอนาคตยังไม่สามารถยืนยันได้ ผมไม่สามารถคาดเดาได้ครับ"
    );
  }

  // ================= OFFICIAL FACTS =================
  if (lowerText.includes("นายก")) {
    return reply(event, `นายกรัฐมนตรีของไทยคือ ${officialFacts.primeMinister}`);
  }

  if (lowerText.includes("เมืองหลวง")) {
    return reply(event, `เมืองหลวงของไทยคือ ${officialFacts.capital}`);
  }

  // ================= AI =================
  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: userText }],
      max_tokens: 200,
    });

    return reply(event, res.choices[0].message.content);
  } catch {
    return reply(event, "ระบบตอบช้าชั่วคราว ขออภัยครับ 🙏");
  }
}

// ================= HELPER =================
function reply(event, text) {
  return client.replyMessage(event.replyToken, {
    type: "text",
    text,
  });
}

app.listen(8080, () => console.log("🚀 Bot running on port 8080"));
