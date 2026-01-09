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
    return reply(
      event,
      "สวัสดีครับ 😊\nก่อนเริ่มใช้งาน ขอทราบชื่อคุณหน่อยครับ"
    );
  }

  const user = users[userId];

  // ================= CHANGE NAME (GLOBAL / SMART) =================
  const changeNameKeywords = [
    "เปลี่ยนชื่อ",
    "เปลียนชื่อ",
    "ขอเปลี่ยนชื่อ",
    "อยากเปลี่ยนชื่อ",
  ];

  if (changeNameKeywords.some(k => lowerText.includes(k))) {
    user.step = "ask_name";
    delete user.name;
    saveUsers();
    return reply(event, "ได้เลยครับ 😊 กรุณาพิมพ์ชื่อใหม่ของคุณ");
  }

  // ================= ASK NAME (HARD VALIDATION) =================
  if (user.step === "ask_name") {

    // ❌ ข้ามไม่ได้เด็ดขาด
    if (["ข้าม", "skip", "ไม่บอก"].includes(lowerText)) {
      return reply(
        event,
        "❌ ขั้นตอนการตั้งชื่อไม่สามารถข้ามได้ครับ\nกรุณาพิมพ์ชื่อจริงที่ใช้เรียก"
      );
    }

    // ❌ ตัวอักษรซ้ำล้วน (กกก / แแ / ่่)
    if (/^(.)(\1)+$/.test(userText)) {
      return reply(event, "❌ กรุณาอย่าพิมพ์ตัวอักษรซ้ำ ๆ");
    }

    // ❌ มีตัวเลขหรือสัญลักษณ์
    if (!/^[ก-๙a-zA-Z\s]+$/.test(userText)) {
      return reply(event, "❌ ใช้ได้เฉพาะภาษาไทยหรืออังกฤษเท่านั้น");
    }

    // ❌ ความยาว
    if (userText.length < 2 || userText.length > 20) {
      return reply(event, "❌ กรุณาพิมพ์ชื่อความยาว 2–20 ตัวอักษร");
    }

    // ================= ตรวจภาษาไทย =================
    const hasThai = /[ก-ฮ]/.test(userText);
    const hasVowel = /[ะาิีึืุูเแโใไำ]/.test(userText);
    const startsWithInvalidThai = /^[ะาิีึืุูเแโใไำ่้๊๋ๆ]/.test(userText);

    if (hasThai) {
      if (startsWithInvalidThai) {
        return reply(event, "❌ รูปแบบชื่อภาษาไทยไม่ถูกต้อง");
      }

      if (!hasVowel) {
        return reply(event, "❌ กรุณาพิมพ์ชื่อที่สามารถอ่านออกเสียงได้");
      }

      if (!/[ก-ฮ][ะาิีึืุูเแโใไำ]/.test(userText)) {
        return reply(event, "❌ กรุณาพิมพ์ชื่อภาษาไทยที่มีโครงสร้างถูกต้อง");
      }
    }

    // ================= ตรวจภาษาอังกฤษ =================
    if (/^[a-zA-Z]+$/.test(userText)) {

      if (userText.length < 4) {
        return reply(event, "❌ ชื่อภาษาอังกฤษต้องยาวอย่างน้อย 4 ตัวอักษร");
      }

      if (!/[aeiou]/i.test(userText)) {
        return reply(event, "❌ กรุณาพิมพ์ชื่อภาษาอังกฤษที่อ่านได้");
      }

      if (/(.)\1{3,}/i.test(userText)) {
        return reply(event, "❌ ชื่อภาษาอังกฤษไม่ควรมีตัวซ้ำมากเกินไป");
      }

      if (/^(qwerty|asdf|zxcv|werty|uiop)/i.test(userText)) {
        return reply(event, "❌ กรุณาพิมพ์ชื่อภาษาอังกฤษที่เป็นชื่อคน");
      }
    }

    // ✅ ผ่านจริงเท่านั้น
    user.name = userText;
    user.step = "ask_age";
    saveUsers();

    return reply(
      event,
      `ยินดีที่ได้รู้จักครับ ${user.name} 😊\nคุณอายุเท่าไหร่ครับ?`
    );
  }

  // ================= ASK AGE =================
  if (user.step === "ask_age") {

    if (["ข้าม", "skip"].includes(lowerText)) {
      return reply(event, "❌ ขั้นตอนอายุไม่สามารถข้ามได้ครับ");
    }

    if (!/^\d+$/.test(userText)) {
      return reply(event, "❌ กรุณาพิมพ์อายุเป็นตัวเลข 1–60 เท่านั้น");
    }

    const age = Number(userText);
    if (age < 1 || age > 60) {
      return reply(event, "❌ กรุณาพิมพ์อายุระหว่าง 1–60 ปี");
    }

    user.age = age;
    user.step = "ask_birthday";
    saveUsers();

    return reply(
      event,
      "วันเกิดของคุณวันไหนครับ?\nตัวอย่าง: 20/11/2548\nหรือพิมพ์ \"ข้าม\""
    );
  }

  // ================= ASK BIRTHDAY (ONLY SKIP HERE) =================
  if (user.step === "ask_birthday") {

    if (["ข้าม", "skip"].includes(lowerText)) {
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

  return reply(event, "ระบบพร้อมใช้งานครับ 😊");
}

// ================= HELPER =================
function reply(event, text) {
  return client.replyMessage(event.replyToken, {
    type: "text",
    text,
  });
}

app.get("/", (req, res) => res.send("ok"));
app.listen(8080, () => console.log("🚀 Server running"));
