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
  if (event.type !== "message" || event.message.type !== "text")
    return reply(event, "ขออภัยครับ ข้อความนี้ไม่รองรับ 😊");

  const userId = event.source?.userId;
  if (!userId) return reply(event, "ไม่สามารถระบุตัวตนผู้ใช้ได้ครับ");

  const userText = event.message.text.trim();
  const lowerText = userText.toLowerCase();

  if (!userText) return reply(event, "กรุณาพิมพ์ข้อความก่อนนะครับ 😊");

  // ===== CREATE USER =====
  if (!users[userId]) {
    users[userId] = { step: "ask_name" };
    saveUsers();
    return reply(event, "สวัสดีครับ 😊\nก่อนเริ่มใช้งาน ขอทราบชื่อคุณหน่อยครับ");
  }

  const user = users[userId];

  // ================= RESET NAME (GLOBAL) =================
  if (lowerText.includes("เปลี่ยนชื่อ") || lowerText.includes("ขอเปลี่ยนชื่อ")) {
    user.step = "ask_name";
    delete user.name;
    saveUsers();
    return reply(event, "ได้เลยครับ 😊 กรุณาพิมพ์ชื่อใหม่ของคุณ");
  }

  // ================= ASK NAME (HARD VALIDATION) =================
  if (user.step === "ask_name") {
    const bannedWords = [
      "ข้าม",
      "skip",
      "ไม่บอก",
      "ไม่บอกชื่อ",
      "test",
      "ทดสอบ",
      "admin",
      "root",
      "null",
      "undefined",
    ];

    // ❌ มีตัวเลขหรือสัญลักษณ์
    if (!/^[ก-๙a-zA-Z\s]+$/.test(userText)) {
      return reply(event, "❌ ใช้ได้เฉพาะภาษาไทยหรืออังกฤษเท่านั้น");
    }

    // ❌ คำต้องห้าม
    if (bannedWords.includes(lowerText)) {
      return reply(event, "❌ กรุณาพิมพ์ชื่อจริงที่ใช้เรียกได้ครับ");
    }

    // ❌ ความยาว
    if (userText.length < 2 || userText.length > 20) {
      return reply(
        event,
        "❌ กรุณาพิมพ์ชื่อความยาว 2–20 ตัวอักษร\n*ขั้นตอนนี้ไม่สามารถข้ามได้ครับ*"
      );
    }

    // ❌ ตัวอักษรซ้ำทั้งหมด (แแ / qqqq / กกก)
    if (/^(.)(\1)+$/.test(userText)) {
      return reply(event, "❌ กรุณาอย่าพิมพ์ตัวอักษรซ้ำ ๆ");
    }

    // ❌ อังกฤษล้วน แต่สั้นเกิน (dde / asd / qwe)
    if (/^[a-zA-Z]+$/.test(userText) && userText.length <= 3) {
      return reply(event, "❌ กรุณาพิมพ์ชื่อภาษาอังกฤษที่มีความหมายมากกว่านี้");
    }

    // ❌ ไทยล้วนแต่ไม่มีสระเลย (ดพพพด / กกกดด)
    const thaiOnly = /^[ก-ฮ]+$/.test(userText);
    const hasThaiVowel = /[ะาิีึืุูเแโใไำ]/.test(userText);
    if (thaiOnly && !hasThaiVowel) {
      return reply(event, "❌ กรุณาพิมพ์ชื่อที่อ่านออกเสียงได้");
    }

    user.name = userText;
    user.step = "ask_age";
    saveUsers();
    return reply(
      event,
      `ยินดีที่ได้รู้จักครับ ${user.name} 😊\nคุณอายุเท่าไหร่ครับ?`
    );
  }

  // ================= ASK AGE (STRICT / NO SKIP) =================
  if (user.step === "ask_age") {
    if (["ข้าม", "skip", "ไม่บอก"].includes(lowerText)) {
      return reply(event, "❌ ขั้นตอนอายุไม่สามารถข้ามได้ครับ");
    }

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

  // ================= ASK BIRTHDAY (ONLY STEP THAT CAN SKIP) =================
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
      return reply(
        event,
        "❌ รูปแบบวันเกิดไม่ถูกต้อง\nกรุณาพิมพ์ DD/MM/YYYY หรือ \"ข้าม\""
      );
    }

    user.birthday = userText;
    user.step = "done";
    saveUsers();
    return reply(
      event,
      `ขอบคุณครับ 🙏\n👤 ${user.name}\n🎂 อายุ ${user.age} ปี\n📅 วันเกิด ${user.birthday}`
    );
  }

  // ================= AFTER DONE =================
  return reply(event, "ระบบพร้อมใช้งานครับ 😊");
}

// ================= HELPER =================
function reply(event, text) {
  return client.replyMessage(event.replyToken, {
    type: "text",
    text,
  });
}

// ================= TEST =================
app.get("/", (req, res) => res.send("ok"));
app.listen(8080, () => console.log("🚀 Server running"));
