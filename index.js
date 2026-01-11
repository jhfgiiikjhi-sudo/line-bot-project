// ========================================
// STC Chatbot - index.js (ULTIMATE FINAL)
// ========================================

const express = require("express");
const app = express();
require("dotenv").config();

const fs = require("fs");
const line = require("@line/bot-sdk");
const OpenAI = require("openai");
const moment = require("moment-timezone");
require("moment/locale/th");

const officialFacts = require("./officialFacts");

// ========================================
// FILE STORAGE
// ========================================
const USERS_FILE = "./users.json";
const NAME_STATS_FILE = "./name_stats.json";

let users = {};
let nameStats = { real: {}, nick: {} };

if (fs.existsSync(USERS_FILE)) {
  try { users = JSON.parse(fs.readFileSync(USERS_FILE, "utf8")); } catch {}
}
if (fs.existsSync(NAME_STATS_FILE)) {
  try { nameStats = JSON.parse(fs.readFileSync(NAME_STATS_FILE, "utf8")); } catch {}
}

const saveUsers = () =>
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
const saveStats = () =>
  fs.writeFileSync(NAME_STATS_FILE, JSON.stringify(nameStats, null, 2));

// ========================================
// LINE CONFIG
// ========================================
const config = {
  channelAccessToken: process.env.token,
  channelSecret: process.env.secretcode,
};
const client = new line.Client(config);

// ========================================
// OPENAI
// ========================================
const openai = new OpenAI({
  apiKey: process.env.OPENAI_KEY,
});

// ========================================
// UTIL (VALIDATION แข็งระดับโปร)
// ========================================
const FORBIDDEN_NAMES = [
  "สวัสดี","หวัดดี","ขอบคุณ","ครับ","ค่ะ","ดีครับ","ดีค่ะ",
  "hello","hi","hey","ok","okay","test","ทดสอบ",
  "admin","user","bot","system"
];

const isForbidden = (t) => FORBIDDEN_NAMES.includes(t.toLowerCase());
const isRepeated = (t) => /^(.)(\1{2,})$/.test(t);

const validThaiEng = (t, min, max) =>
  /^[ก-๙a-zA-Z]+$/.test(t) && t.length >= min && t.length <= max;

// ตรวจชื่อคนจริง (ไทย / อังกฤษ)
function isHumanName(text, min, max) {
  if (!validThaiEng(text, min, max)) return false;
  if (isForbidden(text) || isRepeated(text)) return false;

  // ไทยต้องมีสระ
  if (/^[ก-ฮ]+$/.test(text) && !/[ะาิีึืุูเแโใไำ]/.test(text))
    return false;

  // อังกฤษต้องมีสระ
  if (/^[a-zA-Z]+$/.test(text) && !/[aeiou]/i.test(text))
    return false;

  return true;
}

function looksSwapped(real, nick) {
  if (!real || !nick) return false;

  // ชื่อเล่นยาวกว่าชื่อจริงมาก = น่าสงสัย
  if (nick.length >= real.length + 3) return true;

  // ชื่อจริงสั้นมาก แต่ชื่อเล่นยาว
  if (real.length <= 3 && nick.length >= 6) return true;

  return false;
}

function isLikelyNickname(text) {
  // ชื่อเล่นมักสั้น
  if (text.length <= 4) return true;

  // ชื่อเล่นไม่ค่อยยาวมาก
  if (text.length >= 8) return false;

  return true;
}

// ========================================
// ADD: BAD WORD FILTER (PATCH ONLY)
// ========================================
const BAD_WORDS = [
  "ควย","เหี้ย","สัส","ห่า","หี","ชิบหาย","ฉิบหาย",
  "fuck","shit","bitch","asshole","motherfucker"
];

function hasBadWord(text) {
  const clean = text.replace(/\s+/g, "").toLowerCase();
  return BAD_WORDS.some(w => clean.includes(w));
}

// ลบช่องว่าง เช่น "ค ว ย" → "ควย"
function normalizeBadWord(text) {
  return text.toLowerCase().replace(/\s+/g, "");
}

function hasBadWord(text) {
  const clean = normalizeBadWord(text);
  return BAD_WORDS.some(word => clean.includes(word));
}

// ========================================
// WEBHOOK
// ========================================
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.json({ status: "ok" });
  } catch (err) {
    console.error(err);
    res.status(500).end();
  }
});

// ========================================
// MAIN LOGIC
// ========================================
async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text")
    return reply(event, "ขออภัยครับ รองรับเฉพาะข้อความ 😊");

  const userId = event.source?.userId;
  if (!userId) return reply(event, "ไม่สามารถระบุตัวตนผู้ใช้ได้ครับ");

  const text = event.message.text.trim();
  const lower = text.toLowerCase();
  const now = moment().tz("Asia/Bangkok").locale("th");

  // ===== spam / garbage =====
  if (text.length > 50 || /^[^ก-๙a-zA-Z0-9\s]+$/.test(text))
    return reply(event, "❌ ข้อความไม่ถูกต้องครับ");

  if (hasBadWord(text)) {
  user.badCount = (user.badCount || 0) + 1;

  if (user.badCount >= 3) {
    user.blockedUntil = moment().add(1, "minute");
    user.badCount = 0;
    saveUsers();
    return reply(
      event,
      "⛔ ตรวจพบคำไม่เหมาะสมซ้ำหลายครั้ง\nระบบระงับการใช้งาน 1 นาที"
    );
  }

  saveUsers();
  return reply(
    event,
    `⚠️ กรุณาใช้คำสุภาพ\n(เตือนครั้งที่ ${user.badCount}/3)`
  );
}

  // ===== create user =====
  if (!users[userId]) {
    users[userId] = { step: "ask_realname", badWordCount: 0 };
    saveUsers();
    return reply(event, "สวัสดีครับ ก่อนเริ่มคุยกันผมขอทำความรู้จักคุณหน่อยนะครับ 😊\nกรุณาพิมพ์ **ชื่อจริง** ของคุณ");
  }

  const user = users[userId];

  badCount: 0
    blockedUntil: null

  // ====================================
// ADD: BAD WORD HANDLER (PATCH ONLY)
// ====================================
if (hasBadWord(text)) {
  user.badWordCount = (user.badWordCount || 0) + 1;
  saveUsers();

  if (user.badWordCount === 1) {
    return reply(event, "⚠️ ขอความร่วมมือใช้ถ้อยคำสุภาพหน่อยนะครับ");
  }

  if (user.badWordCount === 2) {
    return reply(event, "⚠️ เตือนอีกครั้งนะครับ ผมอยากช่วยคุณด้วยภาษาที่สุภาพ");
  }

  return reply(event, "🚫 ขออภัยครับ ผมไม่สามารถตอบข้อความลักษณะนี้ได้");
}

  // ====================================
  if (user.blockedUntil && moment().isBefore(user.blockedUntil)) {
  const diff = moment(user.blockedUntil).diff(moment(), "seconds");
  return reply(
    event,
    `⛔ คุณถูกระงับการใช้งานชั่วคราว\nกรุณารออีก ${diff} วินาที`
  );
}

  // ====================================
  // CHANGE COMMANDS (จากโค้ดที่แข็งกว่า)
  // ====================================
  if (lower.includes("เปลี่ยนชื่อเล่น")) {
    user.step = "ask_nickname";
    saveUsers();
    return reply(event, "ได้เลยครับ 😊\nกรุณาพิมพ์ชื่อเล่นใหม่");
  }

  if (lower.includes("เปลี่ยนชื่อ")) {
    user.step = "ask_realname";
    saveUsers();
    return reply(event, "ได้เลยครับ 😊\nกรุณาพิมพ์ชื่อจริงใหม่");
  }

  if (lower.includes("เปลี่ยนอายุ")) {
    user.step = "ask_age";
    saveUsers();
    return reply(event, "ได้เลยครับ 😊\nกรุณาพิมพ์อายุของคุณ");
  }

  // ====================================
  // REGISTER FLOW (แข็ง + ครบ)
  // ====================================
  if (user.step === "ask_realname") {
    if (lower === "ข้าม")
      return reply(event, "❌ ไม่สามารถข้ามชื่อจริงได้");

    if (!isHumanName(text, 2, 20))
      return reply(event, "❌ กรุณาพิมพ์ชื่อจริงที่เป็นชื่อคนจริง");

    user.realName = text;
    user.step = "ask_nickname";
    saveUsers();

    return reply(event, `ขอบคุณครับ ${text} 😊\nขอทราบ **ชื่อเล่น** ด้วยครับ`);
  }

  if (user.step === "ask_nickname") {
    if (lower === "ข้าม")
      return reply(event, "❌ ไม่สามารถข้ามชื่อเล่นได้");

    if (!isHumanName(text, 1, 15))
      return reply(event, "❌ ชื่อเล่นไม่ถูกต้อง");

    // ป้องกันเอาชื่อจริงมาใส่ชื่อเล่น
    if (
    user.realName &&
      text.length >= user.realName.length + 3
) {
  return reply(
    event,
    "⚠️ ชื่อเล่นมักสั้นกว่าชื่อจริงนะครับ\nกรุณาพิมพ์ **ชื่อเล่น** ใหม่อีกครั้ง"
  );
}

    user.nickName = text;
    user.step = "ask_age";
    saveUsers();

    return reply(event, "ต่อไปขอทราบอายุของคุณครับ 🎂");
  }

  if (user.step === "ask_age") {
    const age = Number(text);
    if (!Number.isInteger(age) || age < 1 || age > 60)
      return reply(event, "❌ กรุณาพิมพ์อายุเป็นตัวเลข 1–60");

    user.age = age;
    user.step = "ask_birthday";
    saveUsers();

    return reply(
      event,
      'ต้องการบอกวันเกิดไหมครับ?\nตัวอย่าง: 20/11/2548\nหรือพิมพ์ "ข้าม"'
    );
  }

  if (user.step === "ask_birthday") {
    if (lower === "ข้าม") {
      user.birthday = null;
    } else {
      if (!moment(text, "DD/MM/YYYY", true).isValid())
        return reply(event, "❌ รูปแบบวันเกิดไม่ถูกต้อง");
      user.birthday = text;
    }

    if (looksSwapped(user.realName, user.nickName)) {
      user.step = "ask_realname";
  saveUsers();
      return reply(
      event,
      "⚠️ ดูเหมือนคุณอาจใส่ชื่อจริงและชื่อเล่นสลับกัน\nกรุณาพิมพ์ **ชื่อจริง** ใหม่อีกครั้งครับ"
    );
}

    user.step = "done";

    nameStats.real[user.realName] =
      (nameStats.real[user.realName] || 0) + 1;
    nameStats.nick[user.nickName] =
      (nameStats.nick[user.nickName] || 0) + 1;

    saveUsers();
    saveStats();

    return reply(
      event,
      `✅ ลงทะเบียนสำเร็จ\n\n👤 ${user.realName}\n🎭 ${user.nickName}\n🎂 อายุ ${user.age} ปี`
    );
  }

  // ====================================
  // MULTI INTENT (จากโค้ดแรก)
  // ====================================
  const answers = [];

  if (lower.includes("กี่โมง") || lower.includes("เวลา"))
    answers.push(`⏰ ตอนนี้เวลา ${now.format("HH:mm")} น.`);

  if (lower.includes("วันที่") || lower.includes("วันอะไร"))
    answers.push(`📅 วันนี้วันที่ ${now.format("D MMMM YYYY")}`);

  if (lower.includes("ปีอะไร"))
    answers.push(`🗓 ปี พ.ศ. ${now.year() + 543}`);

  if (lower.includes("อายุ"))
    answers.push(
      user.age ? `🎂 คุณอายุ ${user.age} ปีครับ` : "❗ ยังไม่ได้บันทึกอายุ"
    );

  if (lower.includes("วันเกิด")) {
    if (!user.birthday) {
      answers.push("❗ ยังไม่ได้บันทึกวันเกิด");
    } else {
      const [d, m] = user.birthday.split("/");
      let next = moment.tz(`${now.year()}-${m}-${d}`, "Asia/Bangkok");
      if (next.isBefore(now, "day")) next.add(1, "year");
      answers.push(`🎂 เหลืออีก ${next.diff(now, "days")} วัน`);
    }
  }

  if (lower.includes("ปีใหม่")) {
    const ny = moment.tz(`${now.year() + 1}-01-01`, "Asia/Bangkok");
    answers.push(`🎉 เหลืออีก ${ny.diff(now, "days")} วัน จะถึงวันปีใหม่`);
  }

  if (answers.length > 0)
    return reply(event, answers.join("\n"));

  // ====================================
  // TOP NAME
  // ====================================
  if (lower === "/topname") {
    const top = (obj) =>
      Object.entries(obj)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([n, c]) => `${n} (${c})`)
        .join("\n") || "-";

    return reply(
      event,
      `📊 ชื่อยอดนิยม\n\n🪪 ชื่อจริง:\n${top(
        nameStats.real
      )}\n\n🎭 ชื่อเล่น:\n${top(nameStats.nick)}`
    );
  }

  // ====================================
  // OFFICIAL FACT
  // ====================================
  if (lower.includes("นายก"))
    return reply(
      event,
      `นายกรัฐมนตรีของประเทศไทยคือ ${officialFacts.primeMinister} ครับ`
    );

  // ====================================
  // AI FALLBACK (ปลอดภัย)
  // ====================================
  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "คุณคือแชทบอทสุภาพ ห้ามเดาข้อมูล" },
        { role: "user", content: text },
      ],
      max_tokens: 200,
    });
    return reply(event, res.choices[0].message.content);
  } catch {
    return reply(event, "ขออภัยครับ ผมยังไม่เข้าใจคำถามนี้ 🙏");
  }
}

// ========================================
// HELPER
// ========================================
function reply(event, text) {
  return client.replyMessage(event.replyToken, {
    type: "text",
    text,
  });
}

// ========================================
app.get("/", (_, res) => res.send("ok"));
app.listen(8080, () => console.log("🚀 Server running"));
