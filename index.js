// ========================================
// STC Chatbot - index.js (ULTIMATE FINAL)
// ========================================

const express = require("express");
const app = express();
require("dotenv").config();

const path = require("path");
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
  // 1. เช็คประเภทข้อความ
  if (event.type !== "message") return;

  const userId = event.source?.userId;
  if (!userId) return;

  // 2. ถ้าเป็นรูปภาพ
  if (event.message.type === "image") {
    console.log("📸 ตรวจพบรูปภาพจาก:", userId);
    return await handleImageMessage(event, userId); 
  }

  // 3. ถ้าไม่ใช่ข้อความตัวอักษร ให้หยุด
  if (event.message.type !== "text") return;
  
  const text = event.message.text.trim();
  const lower = text.toLowerCase(); // *** ประกาศตัวแปร lower ที่นี่ ***
  const now = moment().tz("Asia/Bangkok").locale("th");

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

  // ===== 4. CHANGE COMMANDS (ดักจับคำสั่งเปลี่ยนข้อมูล) =====
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

  // ===== 5. REGISTER FLOW (CORE LOGIC) =====
  
  // STEP: ASK REALNAME
  if (user.step && user.step.startsWith("ask_realname")) {
    const isOnly = user.step.endsWith("_only"); // ประกาศค่า isOnly

    if (lower === "ข้าม" && !isOnly) {
      return reply(event, "❌ ไม่สามารถข้ามชื่อจริงได้\nกรุณาพิมพ์ชื่อจริงของคุณ");
    }

    if (!isStrictlyHumanName(text)) {
      return reply(event, "❌ ดูเหมือนไม่ใช่ชื่อจริงที่ถูกต้องครับ\n(ห้ามพิมพ์ตัวอักษรซ้ำมั่ว หรือใส่สัญลักษณ์ครับ)");
    }

    user.realName = text;
    if (isOnly && user.nickName && user.age && user.department) {
      user.step = "done";
      saveUsers();
      return reply(event, `✅ เปลี่ยนชื่อจริงสำเร็จแล้วครับ เป็น: **${text}**`);
    } else {
      user.step = "ask_nickname";
      saveUsers();
      return reply(event, `ขอบคุณครับ คุณ${text} 😊\nต่อไปขอทราบ **ชื่อเล่น** ด้วยครับ`);
    }
  }

  // STEP: ASK NICKNAME
  if (user.step && user.step.startsWith("ask_nickname")) {
    const isOnly = user.step.endsWith("_only");
    if (!isHumanName(text, 1, 15)) return reply(event, "❌ กรุณาใช้ชื่อที่สุภาพครับ");
    
    user.nickName = text;
    if (isOnly) {
      user.step = "done";
      saveUsers();
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
      return reply(event, 'ต้องการบอกวันเกิดไหมครับ? (เช่น 20/11/2548) หรือพิมพ์ "ข้าม"');
    }
  }

  // STEP: ASK BIRTHDAY
  if (user.step === "ask_birthday") {
    if (lower === "ข้าม") {
      user.birthday = null;
    } else {
      if (!moment(text, "DD/MM/YYYY", true).isValid()) return reply(event, "❌ รูปแบบวันเกิดไม่ถูกต้อง");
      user.birthday = text;
    }
    user.step = "ask_department";
    saveUsers();
    return reply(event, `ต่อไปขอทราบ **สาขาวิชา** ของคุณครับ`);
  }

  // STEP: ASK DEPARTMENT
  if (user.step === "ask_department") {
    const foundDept = DEPARTMENTS.find(d => text.includes(d));
    if (!foundDept) {
      return reply(event, `❌ ไม่พบสาขาวิชานี้ในระบบ SPTC\nกรุณาพิมพ์ชื่อสาขาให้ถูกต้อง (เช่น ช่างยนต์, บัญชี)`);
    }
    user.department = foundDept;
    user.step = "done";
    saveUsers();
    return reply(event, `✅ ลงทะเบียนสำเร็จ!\n👤 ${user.realName}\n🎭 ${user.nickName}\n⚙️ แผนก ${user.department}\n🎂 อายุ ${user.age} ปี`);
  }

  // ===== 6. MULTI INTENT (หลังจากสมัครเสร็จแล้ว) =====
  const answers = [];
  if (lower.includes("กี่โมง") || lower.includes("เวลา")) answers.push(`⏰ ตอนนี้เวลา ${now.format("HH:mm")} น.`);
  if (lower.includes("วันที่")) answers.push(`📅 วันนี้วันที่ ${now.format("D MMMM YYYY")}`);
  
  if (answers.length > 0) return reply(event, answers.join("\n"));

  // ===== 7. AI FALLBACK =====
  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: `คุณคือผู้ช่วยของ ${collegeData.collegeName}` },
        { role: "user", content: text },
      ],
    });
    return reply(event, res.choices[0].message.content);
  } catch (err) {
    return reply(event, "ขออภัยครับ ระบบ AI ขัดข้อง");
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
  console.log("🚀 เริ่มต้นฟังก์ชัน handleImageMessage...");
  try {
    const user = users[userId];
    if (!user || user.step !== "done") {
      console.log("⚠️ ผู้ใช้ยังลงทะเบียนไม่เสร็จ");
      return reply(event, "⚠️ กรุณาลงทะเบียนให้เสร็จก่อนส่งรูปภาพนะครับ");
    }

    const downloadPath = path.join(__dirname, "downloads");
    if (!fs.existsSync(downloadPath)) {
      console.log("📁 กำลังสร้างโฟลเดอร์ downloads...");
      fs.mkdirSync(downloadPath, { recursive: true });
    }

    const fileName = `report_${userId}_${Date.now()}.jpg`;
    const filePath = path.join(downloadPath, fileName);
    console.log("📍 กำลังจะบันทึกไปที่:", filePath);

    const stream = await client.getMessageContent(event.message.id);
    const writable = fs.createWriteStream(filePath);

    await new Promise((resolve, reject) => {
      stream.pipe(writable);
      writable.on("finish", () => {
        console.log("✅ เขียนไฟล์ลง Disk สำเร็จ!");
        resolve();
      });
      writable.on("error", (err) => {
        console.log("❌ เขียนไฟล์พลาด:", err);
        reject(err);
      });
    });

    return reply(event, `📸 ได้รับรูปภาพแล้วครับ!\nคุณ ${user.nickName} ต้องการแจ้งเรื่องอะไรครับ?...`);

  } catch (err) {
    console.error("❌ เกิด Error ในฟังก์ชันรูปภาพ:", err);
    reply(event, "❌ ระบบบันทึกรูปภาพขัดข้อง");
  }
}

// ========================================
// START SERVER
// ========================================
app.get("/", (_, res) => res.send("Bot is Online"));
app.listen(8080, () => console.log("🚀 Server running on port 8080"));
