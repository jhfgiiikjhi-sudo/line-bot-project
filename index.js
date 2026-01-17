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

// โหลดข้อมูลแบบกัน Error
const loadData = () => {
    try {
        if (fs.existsSync(USERS_FILE)) users = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
        if (fs.existsSync(NAME_STATS_FILE)) nameStats = JSON.parse(fs.readFileSync(NAME_STATS_FILE, "utf8"));
    } catch (e) {
        console.error("Error loading data:", e);
    }
};
loadData();

const saveUsers = () => fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
const saveStats = () => fs.writeFileSync(NAME_STATS_FILE, JSON.stringify(nameStats, null, 2));

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
  // ลบบรรทัด looksOffensive ออกเพราะไม่มีฟังก์ชันรองรับ
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
  "ควย","เหี้ย","สัส","ห่า","หี","ชิบหาย","ฉิบหาย", "เย็ด" ,"น่าหี" ,"ลูกกะหรี่",
  "fuck","shit","bitch","asshole","motherfucker" ,"Hee","Fuckyou" ,"Kuy" ,"yed" 
];

function normalizeBadWord(text) {
  return text.toLowerCase().replace(/\s+/g, "");
}

function hasBadWord(text) {
  const clean = normalizeBadWord(text);
  return BAD_WORDS.some(word => clean.includes(word));
}

// ========================================
// TEXT NORMALIZE (ANTI EVASION)
// ========================================
function normalizeText(text) {
  return text
    .toLowerCase()
    .replace(/\s+/g, "")       // ลบช่องว่าง
    .replace(/[_\-\.]/g, "")   // ลบ _ - .
}

// ========================================
// BAD WORD PATTERNS (REGEX BASED)
// ========================================
const BAD_PATTERNS = [
  /ค+ว+ย+/,
  /ค+_+ว+_+ย+/,
  /ค+\s*ว+\s*ย+/,

  /เห+ี+้*ย+/,
  /ส+ั+ส+/,
  /ห+ี+/,
  /ช+ิ+บ+ห+า+ย+/,
  /เย+็+ด+/,

  /f+u+c+k+/i,
  /s+h+i+t+/i,
  /b+i+t+c+h+/i,
  /a+s+s+h+o+l+e+/i,
  /h+e+e+/i,
  /k+u+y+/i,
  /y+e+d+/i
];

function containsBadWord(text) {
  const clean = normalizeText(text);
  return BAD_PATTERNS.some(pattern => pattern.test(clean));
}

function detectMessageType(text) {
  const clean = normalizeText(text);

  // ตัวเลขล้วน / วันเกิด = ปกติ
  if (/^\d+$/.test(clean)) return "normal";
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(text)) return "normal";

  // คำหยาบ
  if (containsBadWord(clean)) return "badword";

  // สแปม (ไม่มีตัวอักษรเลย)
  if (!/[ก-๙a-z]/i.test(text)) return "spam";
}
  // ย้ายออกมาไว้นอก detectMessageType
function isSpam(text) {
  if (/^[!?@#\$%\^&\*\(\)\+=\-_.]{3,}$/.test(text)) return true;
  if (/^(.)\1{4,}$/.test(text)) return true;
  return false;
}

function detectMessageType(text) {
  const clean = normalizeText(text);
  if (/^\d+$/.test(clean)) return "normal";
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(text)) return "normal";
  if (containsBadWord(clean)) return "badword";
  if (!/[ก-๙a-z]/i.test(text) || isSpam(text)) return "spam";
  return "normal";
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
// MAIN LOGIC - รวมร่างสมบูรณ์ (Logic ครบทุกบรรทัด)
// ========================================
async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text")
    return reply(event, "ขออภัยครับ รองรับเฉพาะข้อความ 😊");

  const userId = event.source?.userId;
  if (!userId) return reply(event, "ไม่สามารถระบุตัวตนผู้ใช้ได้ครับ");

  const text = event.message.text.trim();
  const lower = text.toLowerCase();
  const now = moment().tz("Asia/Bangkok").locale("th");

  // ===== 1. CREATE USER / INITIAL CHECK =====
  if (!users[userId]) {
    users[userId] = { step: "ask_realname", badCount: 0 };
    saveUsers();
    return reply(event, "สวัสดีครับ ผมคือ STC Bot ก่อนเริ่มคุยกัน 😊\nกรุณาพิมพ์ **ชื่อจริง** ของคุณก่อนนะครับ");
  }

  const user = users[userId];

  // ===== 2. BLOCKED CHECK =====
  if (user.blockedUntil && moment().isBefore(user.blockedUntil)) {
    const diff = moment(user.blockedUntil).diff(moment(), "seconds");
    return reply(event, `⛔ คุณถูกระงับการใช้งานชั่วคราว\nกรุณารออีก ${diff} วินาที`);
  }

  // ===== 3. GLOBAL BAD WORD & SPAM FILTER =====
  const msgType = detectMessageType(text);
  if (msgType !== "normal") {
    user.badCount = (user.badCount || 0) + 1;
    saveUsers();

    if (user.badCount >= 3) {
      user.blockedUntil = moment().add(1, "minute");
      user.badCount = 0;
      saveUsers();
      return reply(event, "⛔ ระบบตรวจพบข้อความไม่เหมาะสมซ้ำหลายครั้ง\nระงับการใช้งาน 1 นาที");
    }

    if (isSpam(text)) {
      return reply(event, "⚠️ ข้อความลักษณะสแปมหรือไม่สื่อความหมาย กรุณาพิมพ์ให้ชัดเจนครับ");
    }

    if (hasBadWord(text)) {
      increaseWarning(userId);
      return reply(event, `⚠️ ❌ ข้อความนี้มีถ้อยคำไม่เหมาะสม กรุณาใช้คำสุภาพครับ\n(เตือนครั้งที่ ${user.badCount}/3)`);
    }
  }

  // ===== 4. LENGTH & GARBAGE CHECK =====
  if (text.length > 50 || /^[^ก-๙a-zA-Z0-9\s]+$/.test(text))
    return reply(event, "❌ ข้อความไม่ถูกต้องครับ");

  // ===== 5. CHANGE COMMANDS (อัปเดตใหม่) =====
  if (lower.includes("เปลี่ยนชื่อเล่น")) {
    user.step = "ask_nickname_only";
    saveUsers();
    return reply(event, "ได้เลยครับ 😊\nกรุณาพิมพ์ชื่อเล่นใหม่ได้เลย");
  }
  if (lower.includes("เปลี่ยนชื่อ")) {
    user.step = "ask_realname_only";
    saveUsers();
    return reply(event, "ได้เลยครับ 😊\nกรุณาพิมพ์ชื่อจริงใหม่ได้เลย");
  }
  if (lower.includes("เปลี่ยนอายุ")) {
    user.step = "ask_age_only";
    saveUsers();
    return reply(event, "ได้เลยครับ 😊\nกรุณาพิมพ์อายุใหม่ของคุณ");
  }

  // ===== 6. REGISTER FLOW (CORE LOGIC - รองรับ ONLY MODE) =====
  
  // STEP: ASK REALNAME
  if (user.step && user.step.startsWith("ask_realname")) {
    const isOnly = user.step.endsWith("_only");
    if (lower === "ข้าม" && !isOnly) return reply(event, "❌ ไม่สามารถข้ามชื่อจริงได้\nกรุณาพิมพ์ชื่อจริงของคุณ เช่น สมชาย, John");
    if (!isHumanName(text, 2, 20)) return reply(event, "❌ กรุณาพิมพ์ชื่อจริงที่เป็นชื่อคนจริง");

    // เก็บสถิติชื่อเก่า (ลบออก 1) และเพิ่มชื่อใหม่ (บวก 1)
    if (isOnly && user.realName) nameStats.real[user.realName] = Math.max(0, (nameStats.real[user.realName] || 1) - 1);
    user.realName = text;
    nameStats.real[text] = (nameStats.real[text] || 0) + 1;

    if (isOnly) {
      user.step = "done";
      saveUsers(); saveStats();
      return reply(event, `✅ เปลี่ยนชื่อจริงสำเร็จแล้วครับ เป็น: **${text}**`);
    } else {
      user.step = "ask_nickname";
      saveUsers();
      return reply(event, `ขอบคุณครับ ${text} 😊\nขอทราบ **ชื่อเล่น** ด้วยครับ`);
    }
  }

  // STEP: ASK NICKNAME
  if (user.step && user.step.startsWith("ask_nickname")) {
    const isOnly = user.step.endsWith("_only");
    if (!isHumanName(text, 1, 15)) return reply(event, "❌ กรุณาใช้ชื่อที่สุภาพและไม่มีสัญลักษณ์พิเศษครับ");
    if (text === user.realName) return reply(event, "⚠️ ชื่อเล่นไม่ควรซ้ำกับชื่อจริงครับ");
    
    if (!isLikelyNickname(text)) return reply(event, "⚠️ ชื่อเล่นมักจะสั้นกว่านี้นะครับ\nถ้านี่คือชื่อเล่นจริง ๆ ให้พิมพ์ซ้ำอีกครั้งได้เลย 😊");

    // ตรวจสลับชื่อ (เฉพาะโหมดลงทะเบียนปกติ)
    if (!isOnly && looksSwapped(user.realName, text)) {
      user.realName = ""; user.step = "ask_realname"; saveUsers();
      return reply(event, "⚠️ ดูเหมือนใส่ชื่อสลับกันครับ\nกรุณาพิมพ์ **ชื่อจริง** ใหม่อีกครั้ง");
    }

    // อัปเดตสถิติ
    if (isOnly && user.nickName) nameStats.nick[user.nickName] = Math.max(0, (nameStats.nick[user.nickName] || 1) - 1);
    user.nickName = text;
    nameStats.nick[text] = (nameStats.nick[text] || 0) + 1;

    if (isOnly) {
      user.step = "done";
      saveUsers(); saveStats();
      return reply(event, `✅ เปลี่ยนชื่อเล่นสำเร็จแล้วครับ เป็น: **${text}**`);
    } else {
      user.step = "ask_age";
      saveUsers();
      return reply(event, "ต่อไปขอทราบอายุของคุณครับ 🎂");
    }
  }

  // STEP: ASK AGE
  if (user.step && user.step.startsWith("ask_age")) {
    const ageInput = parseInt(text);
    const isOnly = user.step.endsWith("_only");
    if (isNaN(ageInput) || ageInput < 1 || ageInput > 60) return reply(event, "❌ อายุควรเป็นตัวเลข 1-60 ปีครับ");
    
    user.age = ageInput;
    if (isOnly) {
      user.step = "done";
      saveUsers();
      return reply(event, `✅ เปลี่ยนอายุสำเร็จแล้วครับ เป็น: **${ageInput} ปี**`);
    } else {
      user.step = "ask_birthday";
      saveUsers();
      return reply(event, 'ต้องการบอกวันเกิดไหมครับ?\nตัวอย่าง: 20/11/2548\nหรือพิมพ์ "ข้าม"');
    }
  }

  // STEP: ASK BIRTHDAY & FINISH
  if (user.step === "ask_birthday") {
    if (lower === "ข้าม") {
      user.birthday = null;
    } else {
      if (!moment(text, "DD/MM/YYYY", true).isValid()) return reply(event, "❌ รูปแบบวันเกิดไม่ถูกต้อง");
      user.birthday = text;
    }

    user.step = "done";
    // เก็บสถิติยอดนิยม
    nameStats.real[user.realName] = (nameStats.real[user.realName] || 0) + 1;
    nameStats.nick[user.nickName] = (nameStats.nick[user.nickName] || 0) + 1;
    
    saveUsers();
    saveStats();
    return reply(event, `✅ ลงทะเบียนสำเร็จ\n\n👤 ${user.realName}\n🎭 ${user.nickName}\n🎂 อายุ ${user.age} ปี`);
  }

  // ===== 7. MULTI INTENT (TIME/DATE/AGE) =====
  const answers = [];
  if (lower.includes("กี่โมง") || lower.includes("เวลา")) answers.push(`⏰ ตอนนี้เวลา ${now.format("HH:mm")} น.`);
  if (lower.includes("วันที่") || lower.includes("วันอะไร")) answers.push(`📅 วันนี้วันที่ ${now.format("D MMMM YYYY")}`);
  if (lower.includes("ปีอะไร")) answers.push(`🗓 ปี พ.ศ. ${now.year() + 543}`);
  if (lower.includes("อายุ")) answers.push(user.age ? `🎂 คุณอายุ ${user.age} ปีครับ` : "❗ ยังไม่ได้บันทึกอายุ");
  
  if (lower.includes("วันเกิด")) {
    if (!user.birthday) {
      answers.push("❗ ยังไม่ได้บันทึกวันเกิด");
    } else {
      const [d, m] = user.birthday.split("/");
      let next = moment.tz(`${now.year()}-${m}-${d}`, "Asia/Bangkok");
      if (next.isBefore(now, "day")) next.add(1, "year");
      answers.push(`🎂 เหลืออีก ${next.diff(now, "days")} วันจะถึงวันเกิด`);
    }
  }

  if (answers.length > 0) return reply(event, answers.join("\n"));

  // ===== 8. TOP NAME COMMAND =====
  if (lower === "/topname") {
    const top = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, c]) => `${n} (${c})`).join("\n") || "-";
    return reply(event, `📊 ชื่อยอดนิยม\n\n🪪 ชื่อจริง:\n${top(nameStats.real)}\n\n🎭 ชื่อเล่น:\n${top(nameStats.nick)}`);
  }

  // ===== 9. OFFICIAL FACT & FINAL FILTERS =====
  if (lower.includes("นายก")) return reply(event, `นายกรัฐมนตรีของประเทศไทยคือ ${officialFacts.primeMinister} ครับ`);
  if (detectMessageType(text) === "badword") return reply(event, "ผมไม่สามารถตอบคำถามที่ไม่สุภาพได้");

  // ===== 10. AI FALLBACK =====
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
// HELPER FUNCTIONS (ย้ายออกมาด้านนอกเพื่อความถูกต้อง)
// ========================================
function reply(event, text) {
  return client.replyMessage(event.replyToken, { type: "text", text });
}

function increaseWarning(userId) {
  console.log(`User ${userId} received a warning.`);
}

app.get("/", (_, res) => res.send("Bot is Online"));
app.listen(8080, () => console.log("🚀 Server running on port 8080"));
