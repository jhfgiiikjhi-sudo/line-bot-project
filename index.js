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

const collegeData = require("./collegeData");
const DEPARTMENTS = [
  "ช่างยนต์", "ช่างไฟฟ้ากำลัง", "ช่างอิเล็กทรอนิกส์", 
  "ช่างกลโรงงาน", "ช่างก่อสร้าง", "ช่างเชื่อมโลหะ", 
  "การบัญชี", "การตลาด", "เทคโนโลยีสารสนเทศ", "IT", "It", "it", 
  "คอมพิวเตอร์กราฟิก", "การจัดการโลจิสติกส์", "ช่างอากาศยาน"
];
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

function isStrictlyHumanName(text) {
  // 1. ดักตัวอักษรซ้ำ (กกกก)
  if (/(.)\1{3,}/.test(text)) return false;

  // 2. ดักสัญลักษณ์และตัวเลข
  if (!/^[a-zA-Zก-๙\s]+$/.test(text)) return false;

  // 3. ดักการรูดแป้น (ฟหกด) - เช็คการเรียงพยัญชนะที่ไม่มีทางเป็นชื่อคน
  // เช่น มีพยัญชนะติดกันเกิน 5 ตัวโดยไม่มีสระ (ในภาษาไทย)
  const thaiConsonantsOnly = /[^ะ-าเ-โใ-ไอุูึืิีี๊็ํัํ]/.source;
  const keyboardSmash = new RegExp(`[ก-ฮ]{5,}`, 'g'); 
  if (keyboardSmash.test(text) && !text.includes("์")) return false; // ถ้าไม่มีตัวการันต์แต่พยัญชนะติดกัน 5 ตัว = รูดแป้น

  // 4. ดักสระวางผิดที่ (เช่น สระเ- วางท้ายคำ หรือ สระะ วางหน้าคำ)
  if (/^[ะาิีึืุูํ].*/.test(text)) return false; // ขึ้นต้นด้วยสระที่วางหน้าไม่ได้
  if (/.*[เแโใไ]$/.test(text)) return false; // ลงท้ายด้วยสระที่วางท้ายไม่ได้

  // 5. ความยาว
  if (text.length < 3 || text.length > 30) return false;

  return true;
}

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

// ฟังก์ชันช่วยตรวจสอบสแปม (สัญลักษณ์ซ้ำ หรือตัวอักษรซ้ำเกินไป)
function isSpam(text) {
  // เช็คสัญลักษณ์ซ้ำ 3 ตัวขึ้นไป เช่น !!! หรือ ???
  if (/^[!?@#\$%\^&\*\(\)\+=\-_.]{3,}$/.test(text)) return true;
  // เช็คตัวอักษรซ้ำเดิม 5 ตัวขึ้นไป เช่น กกกกก
  if (/^(.)\1{4,}$/.test(text)) return true;
  return false;
}

// ฟังก์ชันหลักในการจำแนกประเภทข้อความ
function detectMessageType(text) {
  const clean = normalizeText(text);

  // 1. ตรวจสอบข้อยกเว้น (ตัวเลขล้วน หรือ รูปแบบวันเกิด)
  if (/^\d+$/.test(clean)) return "normal";
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(text)) return "normal";

  // 2. ตรวจสอบคำหยาบ (สำคัญที่สุด)
  if (containsBadWord(clean)) return "badword";

  // 3. ตรวจสอบสแปม (ไม่มีตัวอักษรไทย/อังกฤษ หรือ ตรงเงื่อนไข isSpam)
  if (!/[ก-๙a-z]/i.test(text) || isSpam(text)) return "spam";

  // 4. ถ้าไม่เข้าเงื่อนไขด้านบน ให้ถือว่าเป็นข้อความปกติ
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
  // 1. ปรับให้รับทั้งข้อความ (text) และรูปภาพ (image)
  if (event.type !== "message" || !["text", "image"].includes(event.message.type)) {
    return; // ถ้าส่งสติกเกอร์ หรืออย่างอื่นมา ให้บอทเงียบไว้
  }

  const userId = event.source?.userId;
  if (!userId) return;

  // 2. เพิ่ม Logic สำหรับเช็คว่าสิ่งที่ส่งมาคือ "รูปภาพ" หรือไม่
  if (event.message.type === "image") {
  return await handleImageMessage(event, userId); 
}

  // 3. ถ้าไม่ใช่รูป (แปลว่าเป็นข้อความ) ก็ให้รัน Logic เดิมด้านล่าง
  const text = event.message.text.trim();
  const lower = text.toLowerCase();
  const now = moment().tz("Asia/Bangkok").locale("th");
  
  // ... โค้ดเดิมของคุณที่เหลือทั้งหมด ...

  // ===== 1. CREATE USER / INITIAL CHECK =====
  if (!users[userId]) {
    users[userId] = { step: "ask_realname", badCount: 0 };
    saveUsers();
    return reply(event, "สวัสดีครับก่อนเริ่มคุยมาทำความรู้จักกันก่อนนะครับ 😊\nกรุณาพิมพ์ **ชื่อจริง** ของคุณนะครับ");
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
  
 // STEP: ASK REALNAME (ฉบับแก้ไขเพิ่มความเข้มงวด)
  if (user.step && user.step.startsWith("ask_realname")) {
    const isOnly = user.step.endsWith("_only");

    // 1. ตรวจสอบการข้าม
    if (lower === "ข้าม" && !isOnly) {
      return reply(event, "❌ ไม่สามารถข้ามชื่อจริงได้\nกรุณาพิมพ์ชื่อจริงของคุณ เช่น สมชาย, John");
    }

    // 2. ตรวจสอบความถูกต้อง (ใช้ฟังก์ชันใหม่ isStrictlyHumanName ที่เข้มงวดขึ้น)
    if (!isStrictlyHumanName(text)) {
      return reply(event, "❌ ดูเหมือนไม่ใช่ชื่อจริงที่ถูกต้องครับ\nกรุณาพิมพ์ชื่อจริงของคุณอีกครั้ง (ห้ามพิมพ์ตัวอักษรซ้ำมั่ว หรือใส่สัญลักษณ์ครับ)");
    }

    // 3. จัดการสถิติชื่อ (ลบชื่อเก่าออกถ้ามี)
    if (user.realName && nameStats.real[user.realName]) {
      nameStats.real[user.realName] = Math.max(0, nameStats.real[user.realName] - 1);
      if (nameStats.real[user.realName] === 0) delete nameStats.real[user.realName];
    }
    
    // 4. บันทึกชื่อใหม่
    user.realName = text;
    nameStats.real[text] = (nameStats.real[text] || 0) + 1;

    // 5. ตัดสินใจว่าจะไป Step ไหนต่อ
    // เงื่อนไข: ถ้าเป็นโหมด Only และลงทะเบียนครบทุกอย่างแล้ว (ชื่อเล่น, อายุ, แผนก) ถึงจะยอมให้จบ
    const isRegistered = user.nickName && user.age && user.department;

    if (isOnly && isRegistered) {
      user.step = "done";
      saveUsers(); saveStats();
      return reply(event, `✅ เปลี่ยนชื่อจริงสำเร็จแล้วครับ เป็น: **${text}**`);
    } else {
      // ถ้าเพิ่งสมัคร หรือข้อมูลยังไม่ครบ ให้พาไปถามชื่อเล่นต่อทันที ไม่ต้องให้รอ
      user.step = "ask_nickname";
      saveUsers(); saveStats();
      return reply(event, `ขอบคุณครับ คุณ${text} 😊\nต่อไปขอทราบ **ชื่อเล่น** ด้วยครับ`);
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

  // --- แก้ไขใน STEP: ASK BIRTHDAY ---
if (user.step === "ask_birthday") {
  if (lower === "ข้าม") {
    user.birthday = null;
  } else {
    // ใช้ moment เช็คความถูกต้อง
    if (!moment(text, "DD/MM/YYYY", true).isValid()) {
      return reply(event, "❌ รูปแบบวันเกิดไม่ถูกต้องครับ (ตัวอย่าง: 20/11/2548)");
    }
    user.birthday = text;
  }

  user.step = "ask_department"; 
  saveUsers();
  return reply(event, `ต่อไปขอทราบ **สาขาวิชา** ของคุณครับ\nตัวอย่าง: ช่างยนต์, เทคโนโลยีสารสนเทศ`);
}

// --- เพิ่ม STEP ใหม่: ASK DEPARTMENT ---
if (user.step === "ask_department") {
  // ตรวจสอบว่าสาขาที่พิมพ์มา มีอยู่ในวิทยาลัยไหม
  const foundDept = DEPARTMENTS.find(d => text.includes(d));
  
  if (!foundDept) {
    return reply(event, `❌ ไม่พบสาขาวิชานี้ในระบบของ SPTC\nกรุณาพิมพ์ชื่อสาขาให้ถูกต้อง เช่น "ช่างยนต์" หรือ "บัญชี"`);
  }

  user.department = foundDept;
  user.step = "done"; // จบการลงทะเบียนจริงๆ ตรงนี้
  
  // เก็บสถิติชื่อ (โค้ดเดิมของคุณ)
  nameStats.real[user.realName] = (nameStats.real[user.realName] || 0) + 1;
  nameStats.nick[user.nickName] = (nameStats.nick[user.nickName] || 0) + 1;
  
  saveUsers();
  saveStats();
  
  return reply(event, `✅ ลงทะเบียนสำเร็จ!\n\n👤 ${user.realName}\n🎭 ${user.nickName}\n⚙️ แผนก ${user.department}\n🎂 อายุ ${user.age} ปี`);
}

  // ===== 7. MULTI INTENT (TIME/DATE/AGE) =====
  const answers = [];
  if (lower.includes("กี่โมง") || lower.includes("เวลา")) answers.push(`⏰ ตอนนี้เวลา ${now.format("HH:mm")} น.`);
  if (lower.includes("วันที่") || lower.includes("วันอะไร")) answers.push(`📅 วันนี้วันที่ ${now.format("D MMMM YYYY")}`);
  if (lower.includes("ปีอะไร")) answers.push(`🗓 ปี พ.ศ. ${now.year() + 543}`);
  if (lower.includes("อายุ")) answers.push(user.age ? `🎂 คุณอายุ ${user.age} ปีครับ` : "❗ ยังไม่ได้บันทึกอายุ");
  
  if (lower.includes("วันเกิด")) {
    if (!user.birthday) { // เช็คก่อนว่ามีข้อมูลไหม
      answers.push("❗ คุณยังไม่ได้บันทึกวันเกิดครับ");
    } else {
      const parts = user.birthday.split("/");
      const d = parseInt(parts[0]);
      const m = parseInt(parts[1]);
      let next = moment.tz(`${now.year()}-${m}-${d}`, "Asia/Bangkok");
      if (next.isBefore(now, "day")) next.add(1, "year");
      answers.push(`🎂 เหลืออีก ${next.diff(now, "days")} วันจะถึงวันเกิดคุณครับ`);
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

  // ===== 10. AI FALLBACK (ฉบับอัปเกรดความฉลาด) =====
  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { 
          role: "system", 
          content: `คุณคือผู้ช่วยอัจฉริยะของ ${collegeData.collegeName} 
          ข้อมูลอ้างอิงของวิทยาลัย: ${JSON.stringify(collegeData)}
          กฎการตอบ:
          1. ใช้ข้อมูลจาก 'ข้อมูลอ้างอิง' เป็นอันดับแรก
          2. ถ้าไม่มีในข้อมูลอ้างอิง ให้ตอบอย่างสุภาพตามความรู้ทั่วไปแต่ห้ามเดาข้อมูลเฉพาะ
          3. แนะนำให้นักเรียนติดต่อแผนกที่เกี่ยวข้องตามเบอร์โทรที่ให้ไว้ถ้าจำเป็น`
        },
        { role: "user", content: text },
      ],
      max_tokens: 400, // เพิ่ม token เล็กน้อยเพื่อให้ตอบข้อมูลได้ครบถ้วน
    });
    return reply(event, res.choices[0].message.content);
  } catch (err) {
    console.error("AI Error:", err);
    return reply(event, "ขออภัยครับ ตอนนี้ระบบสมองกลขัดข้องชั่วคราว 🙏");
  }
}
// ========================================
// HELPER FUNCTIONS (ย้ายออกมาด้านนอกเพื่อความถูกต้อง)
// ========================================
function reply(event, text) {
  return client.replyMessage(event.replyToken, { type: "text", text });
}

// แก้ตรงส่วนท้ายไฟล์
function increaseWarning(userId) {
  if (users[userId]) {
    console.log(`User ${userId} ถูกเตือน (แต้มปัจจุบันในระบบ: ${users[userId].badCount})`);
  }
}

async function handleImageMessage(event, userId) {
  try {
    const user = users[userId];
    if (!user || user.step !== "done") {
      return reply(event, "⚠️ กรุณาลงทะเบียนให้เสร็จก่อนส่งรูปภาพนะครับ");
    }

    // 1. ดึงข้อมูลรูปจาก LINE มาเป็น Buffer (ไม่ต้องบันทึกลงเครื่องให้ยุ่งยาก)
    const stream = await client.getMessageContent(event.message.id);
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    const base64Image = buffer.toString("base64"); // แปลงรูปเป็น Base64 ให้ AI อ่าน

      await client.pushMessage(userId, { type: "text", text: "🤖 กำลังวิเคราะห์รูปภาพสักครู่นะครับ..." });

    // 3. ส่งข้อมูลไปที่ OpenAI (Vision API)
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini", // รุ่นที่รองรับการอ่านรูป
      messages: [
        {
          role: "user",
          content: [
            { 
              type: "text", 
              text: `นี่คือรูปภาพจากนักเรียนชื่อ ${user.realName} แผนก ${user.department} ช่วยอธิบายหรือตอบคำถามจากรูปนี้อย่างสุภาพในฐานะผู้ช่วยของ ${collegeData.collegeName}` 
            },
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${base64Image}`,
              },
            },
          ],
        },
      ],
      max_tokens: 500,
    });

    // 4. ส่งผลลัพธ์กลับไปหาผู้ใช้
    return client.pushMessage(userId, {
      type: "text",
      text: "🔍 ผลการวิเคราะห์รูปภาพ:\n\n" + response.choices[0].message.content
    });

  } catch (err) {
    console.error("AI Vision Error:", err);
    return reply(event, "❌ ขออภัยครับ ผมไม่สามารถวิเคราะห์รูปภาพนี้ได้ในขณะนี้");
  }
}

// ========================================
// START SERVER
// ========================================
app.get("/", (_, res) => res.send("Bot is Online"));
app.listen(8080, () => console.log("🚀 Server running on port 8080"));
