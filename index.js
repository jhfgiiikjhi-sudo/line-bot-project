const express = require("express");
const app = express();
require("dotenv").config();

const fs = require("fs");
const line = require("@line/bot-sdk");
const OpenAI = require("openai");
const moment = require("moment-timezone");
require("moment/locale/th");
const officialFacts = require("./officialFacts");

// ================= USER STORAGE =================
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
    await Promise.all(req.body.events.map(handleEvent));
    res.json({ status: "ok" });
  } catch (err) {
    console.error(err);
    res.status(500).end();
  }
});

// ================= MAIN LOGIC =================
async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") {
    return reply(event, "ขออภัยครับ รองรับเฉพาะข้อความเท่านั้น 😊");
  }

  const userId = event.source?.userId;
  if (!userId) return reply(event, "เกิดข้อผิดพลาดในการระบุตัวตน");

  const userText = event.message.text.trim();
  const lowerText = userText.toLowerCase();

  if (!userText) return reply(event, "กรุณาพิมพ์ข้อความก่อนนะครับ");

  // ===== CREATE USER =====
  if (!users[userId]) {
    users[userId] = { step: "ask_name" };
    saveUsers();
    return reply(event, "สวัสดีครับ 😊\nก่อนเริ่มใช้งาน ขอทราบชื่อคุณหน่อยครับ");
  }

  const user = users[userId];

  // ================= RESET =================
  if (lowerText === "รีเซ็ต") {
    delete users[userId];
    saveUsers();
    return reply(event, "รีเซ็ตข้อมูลเรียบร้อยแล้วครับ 🔄");
  }

  // ================= ASK NAME (STRICT) =================
  if (user.step === "ask_name") {
    const text = userText;
    const lower = text.toLowerCase();

    const banned = [
      "ไม่บอก", "test", "ทดสอบ", "123", "abc", "xxx", "zzz"
    ];

    if (banned.includes(lower)) {
      return reply(event, "❌ กรุณาพิมพ์ชื่อจริงที่ใช้เรียกได้ครับ");
    }

    if (text.length < 2 || text.length > 30) {
      return reply(event, "❌ ชื่อควรยาว 2–30 ตัวอักษร");
    }

    if (!/^[a-zA-Zก-๙\s]+$/.test(text)) {
      return reply(event, "❌ ใช้ได้เฉพาะภาษาไทยหรืออังกฤษเท่านั้น");
    }

    const unique = new Set(text.replace(/\s/g, "").split(""));
    if (unique.size < 2) {
      return reply(event, "❌ กรุณาอย่าพิมพ์ตัวอักษรซ้ำ ๆ");
    }

    if (text.replace(/\s/g, "").length < 3) {
      return reply(event, "❌ กรุณาพิมพ์ชื่อให้ชัดเจนกว่านี้");
    }

    user.name = text;
    user.step = "ask_age";
    saveUsers();

    return reply(event, `ยินดีที่ได้รู้จักครับ ${user.name} 😊\nคุณอายุเท่าไหร่ครับ?`);
  }

  // ================= ASK AGE =================
  if (user.step === "ask_age") {
    if (!/^\d+$/.test(userText)) {
      return reply(event, "❌ กรุณาพิมพ์อายุเป็นตัวเลขเท่านั้น (1–60)");
    }

    const age = Number(userText);
    if (age < 1 || age > 60) {
      return reply(event, "❌ อายุควรอยู่ระหว่าง 1–60 ปี");
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
    if (["ข้าม", "skip", "ไม่บอก"].includes(lowerText)) {
      user.birthday = null;
      user.step = "done";
      saveUsers();
      return reply(
        event,
        `ขอบคุณครับ 🙏\n👤 ${user.name}\n🎂 อายุ ${user.age} ปี`
      );
    }

    if (!moment(userText, "DD/MM/YYYY", true).isValid()) {
      return reply(event, "❌ รูปแบบวันเกิดไม่ถูกต้อง (DD/MM/YYYY)");
    }

    user.birthday = userText;
    user.step = "done";
    saveUsers();

    return reply(
      event,
      `ขอบคุณครับ 🙏\n👤 ${user.name}\n🎂 อายุ ${user.age} ปี\n📅 วันเกิด ${user.birthday}`
    );
  }

  // ================= TIME / DATE =================
  const now = moment().tz("Asia/Bangkok").locale("th");

  if (lowerText.includes("กี่โมง")) {
    return reply(event, `⏰ ตอนนี้เวลา ${now.format("HH:mm")} น.`);
  }

  if (lowerText.includes("วันนี้")) {
    return reply(event, `📅 วันนี้คือวัน${now.format("dddd ที่ D MMMM YYYY")}`);
  }

  // ================= FUTURE BLOCK =================
  if (
    lowerText.includes("นายก") &&
    (lowerText.includes("ต่อไป") || lowerText.includes("ในอนาคต"))
  ) {
    return reply(event, "ขออภัยครับ 🙏 ไม่สามารถคาดเดาข้อมูลอนาคตได้");
  }

  // ================= OFFICIAL FACTS =================
  if (lowerText.includes("นายก")) {
    return reply(event, `นายกรัฐมนตรีของประเทศไทยคือ ${officialFacts.primeMinister} ครับ`);
  }

  // ================= AI =================
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "คุณคือแชทบอทภาษาไทย สุภาพ" },
        { role: "user", content: userText }
      ],
      max_tokens: 300,
    });

    return reply(event, completion.choices[0].message.content);
  } catch {
    return reply(event, "ระบบตอบช้าชั่วคราว ขออภัยครับ 🙏");
  }
}

// ================= REPLY =================
function reply(event, text) {
  return client.replyMessage(event.replyToken, {
    type: "text",
    text,
  });
}

// ================= SERVER =================
app.get("/", (req, res) => res.send("OK"));
app.listen(8080, () => console.log("🚀 Bot running"));
